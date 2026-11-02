import { afterEach, describe, expect, it, vi } from "vitest"
import { type TransactionSpec, EditorState } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { forceParsing } from "@codemirror/language"
import {
  editorExtensions,
  editorPerformancePolicy,
  LIVE_PRUNE_MARGIN_CHARS,
  LIVE_WINDOW_CHARS,
  SAFE_PERFORMANCE_POLICY,
  STANDARD_PERFORMANCE_POLICY,
  safeModeRenderingEnabled,
  setEditorPerformancePolicy,
  setLivePreview,
  setSafeModeRendering,
  type EditorPerformancePolicy,
} from "../src/index"
import {
  LIVE_BUILD_CHUNK_CHARS,
  drainPendingLiveBuild,
  liveBuildChunk,
  livePreviewField,
  livePruneOutside,
} from "../src/decorations/build"
import { LIVE_BUILD_SLICE_MS } from "../src/decorations/buildDriver"

// 每行都带 **bold**：任何区间构建都应产出 mark 装饰。
function boldDoc(lines: number) {
  return Array.from({ length: lines }, (_, i) => `line ${i} with **bold** text`).join("\n")
}

// 长行纯文本文档（无任何装饰）：驱动测试只关心 pending/chunk 区间算术。
// CM 的 line.to 是排他端口（换行符位置），line(301).to = 300×201 + 200 = 60500，
// 种子 pending 恰从 60501 起。
function plainDoc(lines: number, lineChars: number) {
  return Array.from({ length: lines }, () => "x".repeat(lineChars - 1) + "0").join("\n")
}

// 窗口化驱动测试文档：前 quoteLines 行是引用行（行装饰 + QuoteMark，供裁剪/重建
// 对拍），空行终止引用（否则后续段落行按 Markdown 惰性延续被并入引用，每行都产
// 出装饰），其余为单换行拼接的纯文本长行（一个段落、零装饰）。所有行统一
// lineChars 长：line k 的 from = (k-1)×(lineChars+1)，line.to = from + lineChars。
function windowedDoc(quoteLines: number, plainLines: number, lineChars: number) {
  const quote = Array.from({ length: quoteLines }, (_, i) =>
    `> q${i} `.padEnd(lineChars, "x")).join("\n")
  const plain = Array.from({ length: plainLines }, () => "x".repeat(lineChars - 1) + "0").join("\n")
  return `${quote}\n\n${plain}`
}

// happy-dom 没有布局，view.visibleRanges 无法用真实滚动驱动；在实例上用
// Object.defineProperty 覆盖（影子化原型 getter，CM 内部 viewport 重算不会覆写
// 它）。to 按半开 [from, to) 口径传入（与 CM 一致）。
function setVisible(view: EditorView, from: number, to: number) {
  Object.defineProperty(view, "visibleRanges", {
    configurable: true,
    value: Object.freeze([{ from, to }]),
  })
}

function mountView(doc: string, anchor?: number) {
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
  return { view, parent, cleanup: () => { view.destroy(); parent.remove() } }
}

// 全量构建视图（forceParsing + 同步排空 pending）：字段级裁剪语义测试的起点。
// 全程同步、不 await —— 驱动的微任务/空闲回调没有机会插入，排空后的 pending 断言
// 不受 Task 2 排空语义干扰。
function drainedView(doc: string) {
  const seeded = mountView(doc)
  forceParsing(seeded.view, doc.length, 10000)
  drainPendingLiveBuild(seeded.view)
  return seeded
}

const pendingOf = (view: EditorView) => view.state.field(livePreviewField).pending
const covers = (pending: { from: number; to: number }[], pos: number) =>
  pending.some(range => range.from <= pos && range.to >= pos)
const specKeys = (view: EditorView) =>
  view.state.field(livePreviewField).specs
    .map(spec => `${spec.tag}:${spec.from}:${spec.to}`)
    .sort()

// 驱动级挂载：树先解析到头，再经 source/live 往返让 field 以完整树重新播种 ——
// pending 起点确定（种子 = 光标 ±300 行），且此后解析器再无 growth 区间并入
// pending（否则 create 时的初始解析边界会把 pending 起点扩进引用区，断言不定）。
function mountedWindowedView(doc: string) {
  const mounted = mountView(doc)
  forceParsing(mounted.view, doc.length, 10000)
  mounted.view.dispatch(setLivePreview(false))
  mounted.view.dispatch(setLivePreview(true))
  return mounted
}

// 记录驱动 dispatch 的 liveBuildChunk / livePruneOutside 区间（按 dispatch 顺序）：
// 驱动行为的直接观测点。TransactionSpec.effects 允许单 effect 或数组，统一成数组。
function recordDriverEffects(view: EditorView) {
  const original = view.dispatch.bind(view)
  const chunks: { from: number; to: number }[] = []
  const prunes: { from: number; to: number }[][] = []
  let dispatches = 0
  vi.spyOn(view, "dispatch").mockImplementation((...specs: TransactionSpec[]) => {
    dispatches++
    for (const spec of specs) {
      const effects = spec.effects ?? []
      for (const effect of Array.isArray(effects) ? effects : [effects]) {
        if (effect.is(liveBuildChunk)) chunks.push(effect.value)
        else if (effect.is(livePruneOutside)) prunes.push(effect.value)
      }
    }
    original(...specs)
  })
  return { chunks, prunes, dispatchCount: () => dispatches }
}

// performance.now 桩：每次调用推进一个预算周期 → 每个 idle 回调恰好构建 1 片。
function stepClock() {
  let now = 0
  return vi.spyOn(performance, "now").mockImplementation(() => (now += LIVE_BUILD_SLICE_MS))
}

// 步进到驱动再构建 n 片（与 buildDriver.test.ts 同款：advanceTimersToNextTimer 每次
// 恰好触发一个定时器；上限保护只防杂散定时器死循环）。
function tickUntilChunks(recorded: { chunks: { from: number; to: number }[] }, count: number) {
  for (let guard = 0; recorded.chunks.length < count && guard < 10 * count + 20; guard++) {
    vi.advanceTimersToNextTimer()
  }
  expect(recorded.chunks.length).toBe(count)
}

// pending 不变量：有序、互不相交、行对齐（窗口裁剪归还的区间口径）。
function expectPendingInvariants(view: EditorView) {
  const pending = pendingOf(view)
  for (const range of pending) {
    expect(range.from).toBeLessThanOrEqual(range.to)
    expect(range.from).toBe(view.state.doc.lineAt(range.from).from)
    expect(range.to).toBe(view.state.doc.lineAt(range.to).to)
  }
  for (let i = 1; i < pending.length; i++) {
    expect(pending[i - 1].to + 1).toBeLessThanOrEqual(pending[i].from)
  }
}

// 字段级不变量：specs 键唯一，deco 与 specs 1:1，atomic ⊆ deco。
function expectFieldConsistency(view: EditorView) {
  const field = view.state.field(livePreviewField)
  const keys = field.specs.map(spec => `${spec.tag}:${spec.from}:${spec.to}`)
  expect(new Set(keys).size).toBe(keys.length)
  expect(field.deco.size).toBe(field.specs.length)
  expect(field.atomic.size).toBeLessThanOrEqual(field.deco.size)
}

// 字段级（livePruneOutside 直接驱动，全局开关保持默认关闭）：开关只约束驱动策略，
// effect 即显式指令 —— 也避免 happy-dom 真实 visibleRanges（整文档）把排空语义
// 混进区间断言。驱动策略（窗口化排空/滚动裁剪）在下方 fake timers 组覆盖。
describe("safe mode window pruning (field effect)", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("removes only fully-outside specs and returns line-aligned spans to pending", () => {
    const doc = boldDoc(60)
    const { view, cleanup } = drainedView(doc)
    const before = view.state.field(livePreviewField)
    expect(before.pending).toEqual([])
    const mid = Math.floor(doc.length / 2)

    view.dispatch({ effects: livePruneOutside.of([{ from: 0, to: mid }]) })
    const after = view.state.field(livePreviewField)

    // 保留的装饰都与窗口相交（窗口从 0 起 ⇒ from <= mid），被裁的完全在外
    expect(after.specs.length).toBeGreaterThan(0)
    expect(after.specs.length).toBeLessThan(before.specs.length)
    expect(after.specs.every(spec => spec.from <= mid)).toBe(true)
    // 被裁位置回到 pending，窗口内位置不在 pending
    const pruned = before.specs.find(spec => spec.from > mid)
    expect(pruned).toBeDefined()
    expect(covers(after.pending, pruned!.from)).toBe(true)
    expectPendingInvariants(view)
    expectFieldConsistency(view)
    cleanup()
  })

  it("prunes against every region of a multi-region window (gaps prune too)", () => {
    const doc = boldDoc(60)
    const { view, cleanup } = drainedView(doc)
    const before = view.state.field(livePreviewField)

    view.dispatch({
      effects: livePruneOutside.of([{ from: 0, to: 300 }, { from: 600, to: doc.length }]),
    })
    const after = view.state.field(livePreviewField)
    // 保留 = 与任一段相交；完全落在两段间隙 (300, 600) 内的装饰也被裁
    expect(after.specs.length).toBeLessThan(before.specs.length)
    expect(after.specs.every(spec => spec.from <= 300 || spec.to >= 600)).toBe(true)
    expect(after.specs.some(spec => spec.from > 300 && spec.to < 600)).toBe(false)
    expectPendingInvariants(view)
    expectFieldConsistency(view)
    cleanup()
  })

  it("rebuilds pruned decorations to full parity when pending drains again", () => {
    const doc = boldDoc(60)
    const { view, cleanup } = drainedView(doc)
    const keys0 = specKeys(view)
    expect(keys0.length).toBeGreaterThan(0)

    view.dispatch({ effects: livePruneOutside.of([{ from: 0, to: Math.floor(doc.length / 2) }]) })
    expect(pendingOf(view).length).toBeGreaterThan(0)
    drainPendingLiveBuild(view)

    // 无丢失、无重复：重建后的键集合与裁剪前的全量构建完全一致
    expect(pendingOf(view)).toEqual([])
    expect(specKeys(view)).toEqual(keys0)
    expectFieldConsistency(view)
    cleanup()
  })

  it("treats a window covering the document as a no-op prune", () => {
    const doc = boldDoc(60)
    const { view, cleanup } = drainedView(doc)
    const keys0 = specKeys(view)

    view.dispatch({ effects: livePruneOutside.of([{ from: 0, to: doc.length }]) })
    expect(pendingOf(view)).toEqual([])
    expect(specKeys(view)).toEqual(keys0)
    expectFieldConsistency(view)
    cleanup()
  })

  it("applies a doc change and a subsequent prune in tr.state coordinates", () => {
    const doc = boldDoc(60)
    const { view, cleanup } = drainedView(doc)
    const before = view.state.field(livePreviewField)
    // 先变更再裁剪（裁剪窗口按新坐标）：文首插入 10 字符后窗口从 mid+10 起
    view.dispatch({ changes: { from: 0, insert: "0123456789" } })
    const half = Math.floor((doc.length + 10) / 2)
    view.dispatch({ effects: livePruneOutside.of([{ from: half, to: doc.length + 10 }]) })
    const after = view.state.field(livePreviewField)
    expect(after.specs.length).toBeGreaterThan(0)
    expect(after.specs.length).toBeLessThan(before.specs.length)
    expect(after.specs.every(spec => spec.to >= half)).toBe(true)
    expectPendingInvariants(view)
    expectFieldConsistency(view)
    cleanup()
  })

  it("composes an in-window chunk with an out-of-window prune in one transaction", () => {
    const doc = boldDoc(60)
    const { view, cleanup } = drainedView(doc)
    // 驱动滚到新视口时的真实形态：可见区分片（⊆ 构建窗口）+ 裁剪窗口外归还，
    // 同一笔交易内互不冲突。
    view.dispatch({
      effects: [
        liveBuildChunk.of({ from: 100, to: 200 }),
        livePruneOutside.of([{ from: 0, to: 300 }]),
      ],
    })
    const after = view.state.field(livePreviewField)
    // 分片区间从 pending 扣除；窗口外装饰归还 pending；窗口（含分片）内保留
    expect(covers(after.pending, 400)).toBe(true)
    expect(after.specs.length).toBeGreaterThan(0)
    expect(after.specs.every(spec => spec.from <= 300)).toBe(true)
    expectPendingInvariants(view)
    expectFieldConsistency(view)
    cleanup()
  })

  it("maps pending through an edit deep inside the pruned region", () => {
    const doc = boldDoc(60)
    const { view, cleanup } = drainedView(doc)
    view.dispatch({ effects: livePruneOutside.of([{ from: 0, to: Math.floor(doc.length / 2) }]) })
    const pending = pendingOf(view)
    const last = pending[pending.length - 1]

    // pending 深处删除 5 字符（ChangeSpec 的 to 排他）：区间左端不动、右端 -5
    const target = last.from + 5
    view.dispatch({ changes: { from: target, to: target + 5 } })
    const mapped = pendingOf(view)
    expect(mapped[mapped.length - 1]).toEqual({ from: last.from, to: last.to - 5 })
    expectPendingInvariants(view)
    cleanup()
  })

  it("maps pending through an insertion inside the kept window", () => {
    const doc = boldDoc(60)
    const { view, cleanup } = drainedView(doc)
    view.dispatch({ effects: livePruneOutside.of([{ from: 0, to: Math.floor(doc.length / 2) }]) })
    const pending = pendingOf(view)
    expect(pending[0].from).toBeGreaterThan(10)

    // 窗口内（pending 之前）插入：pending 整体右移，映射正常
    view.dispatch({ changes: { from: 10, insert: "0123456789" } })
    expect(pendingOf(view)).toEqual(
      pending.map(range => ({ from: range.from + 10, to: range.to + 10 })))
    cleanup()
  })
})

// 驱动级（safeModeRenderingEnabled() 开启 + fake timers + visibleRanges stub）：
// 窗口化排空、滚动裁剪/重建、迟滞、往返不累积。stub 宿主中滚动不产生 viewport
// 变化更新，用「setVisible + 一笔 selection 交易」模拟（selectionSet 同样置位
// windowDirty —— 光标也是窗口锚点）。
describe("safe mode windowed driver", () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    setSafeModeRendering(false)
  })

  it("exports the windowing constants and toggles the global flag", () => {
    expect(safeModeRenderingEnabled()).toBe(false)
    setSafeModeRendering(true)
    expect(safeModeRenderingEnabled()).toBe(true)
    setSafeModeRendering(false)
    expect(safeModeRenderingEnabled()).toBe(false)
    expect(LIVE_WINDOW_CHARS).toBe(262_144)
    expect(LIVE_PRUNE_MARGIN_CHARS).toBe(32_768)
    expect(LIVE_BUILD_CHUNK_CHARS).toBe(262_144)
  })

  it("drains pending to completion when windowing is off (Task 2 parity)", async () => {
    vi.useFakeTimers()
    stepClock()
    const doc = plainDoc(4000, 200)                     // 803999 chars
    const { view, cleanup } = mountView(doc)            // 光标 0 → 单段 pending
    setVisible(view, 0, 30)
    const { chunks, prunes } = recordDriverEffects(view)
    await Promise.resolve()
    tickUntilChunks({ chunks }, 3)                      // 排空：3 片，无裁剪
    expect(pendingOf(view)).toEqual([])
    expect(prunes).toEqual([])
    expect(chunks).toEqual([
      { from: 60501, to: 322644 },                      // 种子尾（line(301).to+1）起
      { from: 322645, to: 584788 },
      { from: 584789, to: 803999 },
    ])
    cleanup()
  })

  it("builds only in-window pending and keeps out-of-window pending untouched", async () => {
    vi.useFakeTimers()
    stepClock()
    setSafeModeRendering(true)
    const doc = plainDoc(4000, 200)                     // 803999 chars
    const { view, cleanup } = mountView(doc)
    setVisible(view, 0, 30)                             // 构建窗口 [0, 262173]
    const { chunks, prunes } = recordDriverEffects(view)
    await Promise.resolve()
    tickUntilChunks({ chunks }, 1)
    // 只构建窗口内部分；窗口外 pending 原样保留，idle 循环随之自停
    expect(chunks).toEqual([{ from: 60501, to: 262173 }])
    expect(pendingOf(view)).toEqual([{ from: 262174, to: 803999 }])
    expect(prunes).toEqual([])                          // plain 文档无 specs → 无裁剪

    // 窗口外（pending 深处）插入：pending 正确映射，不触发任何构建
    view.dispatch({ changes: { from: 500000, insert: "0123456789" } })
    await Promise.resolve()
    expect(pendingOf(view)).toEqual([{ from: 262174, to: 804009 }])
    expect(chunks).toHaveLength(1)

    // 窗口内（已建区）插入：pending 右移，映射正常
    view.dispatch({ changes: { from: 100000, insert: "0123456789" } })
    await Promise.resolve()
    expect(pendingOf(view)).toEqual([{ from: 262184, to: 804019 }])
    expect(chunks).toHaveLength(1)
    cleanup()
  })

  it("keeps decorations just outside the build window until the prune margin passes", async () => {
    vi.useFakeTimers()
    stepClock()
    setSafeModeRendering(true)
    const doc = windowedDoc(30, 1060, 300)              // 328090 chars，引用区 [0, 9029]
    const { view, cleanup } = mountedWindowedView(doc)
    setVisible(view, 0, 30)                             // 构建窗口 [0, 262173]
    const { chunks, prunes } = recordDriverEffects(view)
    await Promise.resolve()
    tickUntilChunks({ chunks }, 1)
    expect(pendingOf(view)).toEqual([{ from: 262174, to: 328090 }])
    const topKeys = specKeys(view)
    expect(topKeys.length).toBeGreaterThan(0)           // 引用区（≤ 9029）已建

    // 滚到中部 [280000, 280030)：构建窗口 [17856, …] 已完全越过引用区（> 9029），
    // 裁剪窗口（可见 ± 294912，负端钳到 0）仍覆盖全文档 → 迟滞：不裁剪
    setVisible(view, 280000, 280030)
    view.dispatch({ selection: { anchor: 1 } })
    await Promise.resolve()
    tickUntilChunks({ chunks }, 4)
    expect(prunes).toEqual([])
    expect(specKeys(view)).toEqual(topKeys)
    // 窗口覆盖了其余全部 pending → 排空（这正是「构建窗口已不含已建装饰」的观测点）
    expect(pendingOf(view)).toEqual([])
    cleanup()
  }, 30_000)

  it("prunes built decorations on scroll away and rebuilds them identically on return", async () => {
    vi.useFakeTimers()
    stepClock()
    setSafeModeRendering(true)
    const doc = windowedDoc(300, 1800, 300)             // 632100 chars，引用区 [0, 90299]
    const { view, cleanup } = mountedWindowedView(doc)
    setVisible(view, 0, 30)                             // 构建窗口 [0, 262173]
    const { chunks, prunes } = recordDriverEffects(view)
    await Promise.resolve()
    tickUntilChunks({ chunks }, 1)
    expect(chunks[0]).toEqual({ from: 90301, to: 262173 })
    expect(pendingOf(view)).toEqual([{ from: 262174, to: 632100 }])
    const topKeys = specKeys(view)
    expect(topKeys.length).toBeGreaterThan(0)

    // 滚到文末：首帧通道单笔交易 = 可见区分片 + 裁剪（窗口 [337158, 632100]）；
    // idle 随后构建新构建窗口内的剩余（含文末点位）
    setVisible(view, doc.length - 30, doc.length)
    view.dispatch({ selection: { anchor: 1 } })
    await Promise.resolve()
    tickUntilChunks({ chunks }, 4)
    expect(prunes).toEqual([[{ from: 337158, to: 632100 }]])
    expect(chunks[1]).toEqual({ from: 632070, to: 632099 })   // 可见区分片
    expect(chunks[2]).toEqual({ from: 369926, to: 632069 })   // idle 窗口剩余
    expect(chunks[3]).toEqual({ from: 632100, to: 632100 })   // 文末点位
    // 顶部装饰全部归还 pending（引用区行对齐 span [0, 90299]；空行已零装饰不发 spec），specs 清空
    expect(view.state.field(livePreviewField).specs).toHaveLength(0)
    expect(pendingOf(view)).toEqual([
      { from: 0, to: 90299 },
      { from: 262174, to: 369925 },
    ])

    // 滚回顶部：可见区分片 + idle 重建被裁区域，与首次构建完全对拍
    setVisible(view, 0, 30)
    view.dispatch({ selection: { anchor: 0 } })
    await Promise.resolve()
    tickUntilChunks({ chunks }, 6)
    expect(chunks[4]).toEqual({ from: 0, to: 29 })
    expect(chunks[5]).toEqual({ from: 30, to: 90299 })
    expect(specKeys(view)).toEqual(topKeys)
    expect(pendingOf(view)).toEqual([{ from: 262174, to: 369925 }])
    expectFieldConsistency(view)

    // 第二轮往返：specs 数与 pending 形态与上一轮稳态完全一致（不累积）。第二轮
    // 滚出比第一轮更省：构建窗口内的 [369926, 632069] 一带第一轮已建且从未离开
    // 裁剪窗口 → 不经 pending 重建，仅补一笔裁剪（可见区已在 pending 外）
    setVisible(view, doc.length - 30, doc.length)
    view.dispatch({ selection: { anchor: 1 } })
    await Promise.resolve()
    for (let guard = 0; guard < 10; guard++) vi.advanceTimersToNextTimer()
    expect(chunks).toHaveLength(6)
    expect(prunes).toHaveLength(2)
    expect(view.state.field(livePreviewField).specs).toHaveLength(0)
    expect(pendingOf(view)).toEqual([
      { from: 0, to: 90299 },
      { from: 262174, to: 369925 },
    ])
    setVisible(view, 0, 30)
    view.dispatch({ selection: { anchor: 0 } })
    await Promise.resolve()
    tickUntilChunks({ chunks }, 8)
    expect(chunks[6]).toEqual({ from: 0, to: 29 })
    expect(chunks[7]).toEqual({ from: 30, to: 90299 })
    expect(specKeys(view)).toEqual(topKeys)
    expect(view.state.field(livePreviewField).specs).toHaveLength(topKeys.length)
    expect(pendingOf(view)).toEqual([{ from: 262174, to: 369925 }])
    cleanup()
  }, 30_000)
})

// 按视图性能策略（performancePolicy.ts）：显式本地策略优先，缺省回退全局开关。
// 下列用例是「实验路径 vs 遗留全局控制」的对拍与隔离/在途切换回归。
describe("per-editor windowing policy", () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    setSafeModeRendering(false)
  })

  // 632100 chars：引用区 [0, 90299]（种子装饰），其余为纯文本长行。
  const POLICY_DOC = windowedDoc(300, 1800, 300)

  interface WindowRun {
    chunks: { from: number; to: number }[]
    prunes: { from: number; to: number }[][]
    pending: { from: number; to: number }[]
    specs: string[]
  }

  // 对拍运行：policy === null 表示遗留全局开关；否则全局关闭、视图带显式本地策略。
  // 文档、桩视口、调度步进完全相同，只在「策略来源」上不同。
  async function runWindowedDriver(
    policy: EditorPerformancePolicy | null,
    ticks: number,
  ): Promise<WindowRun> {
    vi.useFakeTimers()
    stepClock()
    if (policy === null) setSafeModeRendering(true)
    const { view, cleanup } = mountedWindowedView(POLICY_DOC)
    if (policy) setEditorPerformancePolicy(view, policy)
    setVisible(view, POLICY_DOC.length - 30, POLICY_DOC.length)
    const recorded = recordDriverEffects(view)
    await Promise.resolve()
    for (let index = 0; index < ticks; index++) vi.advanceTimersToNextTimer()
    const run: WindowRun = {
      chunks: recorded.chunks.map(chunk => ({ ...chunk })),
      prunes: recorded.prunes.map(regions => regions.map(region => ({ ...region }))),
      pending: pendingOf(view).map(range => ({ ...range })),
      specs: specKeys(view),
    }
    cleanup()
    setSafeModeRendering(false)
    return run
  }

  it("matches legacy global windowing at one document, viewport, and scheduler checkpoint", async () => {
    const legacy = await runWindowedDriver(null, 3)
    const local = await runWindowedDriver(SAFE_PERFORMANCE_POLICY, 3)
    expect(legacy.chunks.length).toBeGreaterThan(0)
    expect(legacy.prunes).toHaveLength(1)
    expect(legacy.specs).toEqual([])
    expect(local).toEqual(legacy)
  })

  it("matches legacy standard mode after a complete drain", () => {
    const doc = boldDoc(60)
    const legacy = drainedView(doc)
    const local = mountView(doc)
    setEditorPerformancePolicy(local.view, STANDARD_PERFORMANCE_POLICY)

    forceParsing(local.view, doc.length, 10000)
    drainPendingLiveBuild(local.view)

    expect(editorPerformancePolicy(local.view.state)).toEqual(STANDARD_PERFORMANCE_POLICY)
    expect(pendingOf(local.view)).toEqual(pendingOf(legacy.view))
    expect(specKeys(local.view)).toEqual(specKeys(legacy.view))
    expect(specKeys(local.view).length).toBeGreaterThan(0)
    legacy.cleanup()
    local.cleanup()
  })

  it("keeps another view's transactions, effects, pending, and DOM untouched", async () => {
    vi.useFakeTimers()
    stepClock()
    const a = mountView(POLICY_DOC)
    const b = mountView(POLICY_DOC)
    setEditorPerformancePolicy(a.view, STANDARD_PERFORMANCE_POLICY)
    setEditorPerformancePolicy(b.view, SAFE_PERFORMANCE_POLICY)
    expect(editorPerformancePolicy(a.view.state)).toEqual(STANDARD_PERFORMANCE_POLICY)
    expect(editorPerformancePolicy(b.view.state)).toEqual(SAFE_PERFORMANCE_POLICY)
    setVisible(a.view, 0, 30)
    setVisible(b.view, 0, 30)
    const recordedA = recordDriverEffects(a.view)
    const recordedB = recordDriverEffects(b.view)

    await Promise.resolve()
    drainPendingLiveBuild(a.view)
    for (let guard = 0; guard < 20; guard++) vi.advanceTimersToNextTimer()
    // A（标准配置）：排空到全量；B（安全配置）：只建构建窗口内的 pending
    expect(pendingOf(a.view)).toEqual([])
    expect(pendingOf(b.view).length).toBeGreaterThan(0)
    expect(recordedB.chunks.length).toBeGreaterThan(0)

    const aDispatches = recordedA.dispatchCount()
    const aPending = pendingOf(a.view).map(range => ({ ...range }))
    const aSpecs = specKeys(a.view)
    const aDom = a.view.dom.textContent
    expect(aSpecs.length).toBeGreaterThan(0)

    // B 独立经历滚动 + 策略往返：A 不得收到任何交易/effect，也不得改变状态或 DOM
    setVisible(b.view, POLICY_DOC.length - 30, POLICY_DOC.length)
    b.view.dispatch({ selection: { anchor: 1 } })
    await Promise.resolve()
    for (let guard = 0; guard < 10; guard++) vi.advanceTimersToNextTimer()
    setEditorPerformancePolicy(b.view, STANDARD_PERFORMANCE_POLICY)
    await Promise.resolve()
    for (let guard = 0; guard < 10; guard++) vi.advanceTimersToNextTimer()
    setEditorPerformancePolicy(b.view, SAFE_PERFORMANCE_POLICY)
    await Promise.resolve()
    for (let guard = 0; guard < 10; guard++) vi.advanceTimersToNextTimer()

    expect(recordedB.dispatchCount()).toBeGreaterThan(1)
    expect(recordedA.dispatchCount()).toBe(aDispatches)
    expect(recordedA.prunes).toEqual([])
    expect(pendingOf(a.view)).toEqual(aPending)
    expect(specKeys(a.view)).toEqual(aSpecs)
    expect(a.view.dom.textContent).toBe(aDom)
    a.cleanup()
    b.cleanup()
  }, 30_000)

  it("drains every pending range after switching safe → standard", async () => {
    vi.useFakeTimers()
    stepClock()
    const { view, cleanup } = mountedWindowedView(POLICY_DOC)
    setEditorPerformancePolicy(view, SAFE_PERFORMANCE_POLICY)
    setVisible(view, 0, 30)
    const recorded = recordDriverEffects(view)

    await Promise.resolve()
    tickUntilChunks({ chunks: recorded.chunks }, 1)
    expect(pendingOf(view).length).toBeGreaterThan(0)
    expect(recorded.prunes).toEqual([])
    const windowedPending = pendingOf(view).map(range => ({ ...range }))
    expect(windowedPending[windowedPending.length - 1].to).toBe(POLICY_DOC.length)

    const clearCalls: unknown[] = []
    const realClearTimeout = globalThis.clearTimeout
    vi.spyOn(globalThis, "clearTimeout").mockImplementation(handle => {
      clearCalls.push(handle)
      realClearTimeout(handle)
    })
    setEditorPerformancePolicy(view, STANDARD_PERFORMANCE_POLICY)
    // 已在途的 idle 调度被保留（安全 → 标准不取消任何回调），由它继续把 pending 排空
    expect(clearCalls).toEqual([])
    await Promise.resolve()
    for (let guard = 0; guard < 20 && pendingOf(view).length > 0; guard++) {
      vi.advanceTimersToNextTimer()
    }

    expect(pendingOf(view)).toEqual([])
    expect(recorded.prunes).toEqual([])
    expect(recorded.chunks[recorded.chunks.length - 1].to).toBe(POLICY_DOC.length)
    expect(specKeys(view).length).toBeGreaterThan(0)
    expectFieldConsistency(view)
    cleanup()
  }, 30_000)

  it("cancels the queued idle slice, arms a fresh pass, and prunes on standard → safe", async () => {
    vi.useFakeTimers()
    stepClock()
    const { view, cleanup } = mountedWindowedView(POLICY_DOC)
    setVisible(view, POLICY_DOC.length - 30, POLICY_DOC.length)

    const timersAtMount = vi.getTimerCount()
    await Promise.resolve()
    // 标准模式首帧已排 idle（pending 非空）：下面保持这个在途状态再切策略
    expect(vi.getTimerCount()).toBe(timersAtMount + 1)

    const timersBefore = vi.getTimerCount()
    const clearCalls: unknown[] = []
    const realClearTimeout = globalThis.clearTimeout
    vi.spyOn(globalThis, "clearTimeout").mockImplementation(handle => {
      clearCalls.push(handle)
      realClearTimeout(handle)
    })
    setEditorPerformancePolicy(view, SAFE_PERFORMANCE_POLICY)
    // 旧 idle 回调被取消：恰好一次取消（否则 idleScheduled 仍为 true，arm() 早退，
    // 下面那次裁剪根本不会发生）
    expect(clearCalls).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(timersBefore - 1)

    // 重配置会重新播种：先同步排空到全量，让首帧通道在没有 pending 的状态下运行
    drainPendingLiveBuild(view)
    expect(pendingOf(view)).toEqual([])
    const recorded = recordDriverEffects(view)
    await Promise.resolve()

    // 新首帧通道已武装：pending 为空也照做窗口维护，裁剪出构建/裁剪窗口外的全量装饰
    expect(recorded.prunes).toEqual([[{ from: 337158, to: POLICY_DOC.length }]])
    expect(recorded.chunks).toEqual([])
    const prunedPending = pendingOf(view)
    expect(prunedPending.length).toBeGreaterThan(0)
    // 无窗口内 pending（无窗口内可建内容）：迟滞窗口外的装饰全部回到 pending
    expect(prunedPending.every(range => range.to < 337158)).toBe(true)
    expect(specKeys(view)).toEqual([])

    // 被取消的 idle 回调无法再排空任何 pending
    const afterPrune = pendingOf(view).map(range => ({ ...range }))
    for (let guard = 0; guard < 10; guard++) vi.advanceTimersToNextTimer()
    expect(recorded.chunks).toEqual([])
    expect(pendingOf(view)).toEqual(afterPrune)
    expectPendingInvariants(view)
    cleanup()
  }, 30_000)

})
