import { afterEach, describe, expect, it, vi } from "vitest"
import { type TransactionSpec, EditorState } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { editorExtensions, setLivePreview } from "../src/index"
import { LIVE_BUILD_CHUNK_CHARS, liveBuildChunk, livePreviewField } from "../src/decorations/build"
import { LIVE_BUILD_SLICE_MS, LIVE_IDLE_TIMEOUT_MS } from "../src/decorations/buildDriver"

// 每行都带 **bold**：pending 非空时任何区间构建都应产出 mark 装饰。
function boldDoc(lines: number) {
  return Array.from({ length: lines }, (_, i) => `line ${i} with **bold** text`).join("\n")
}

// 长行纯文本文档（~200 字符/行）：解析便宜，切片口径测试只关心区间算术。
function plainDoc(lines: number, lineChars: number) {
  return Array.from({ length: lines }, () => "x".repeat(lineChars - 1) + "0").join("\n")
}

// happy-dom 没有布局，view.visibleRanges 无法用真实滚动驱动；在实例上用
// Object.defineProperty 覆盖（影子化原型 getter，CM 内部 viewport 重算不会覆写
// 它），得到确定性的视口优先级场景。to 按半开 [from, to) 口径传入（与 CM 一致）。
function setVisible(view: EditorView, from: number, to: number) {
  Object.defineProperty(view, "visibleRanges", {
    configurable: true,
    value: Object.freeze([{ from, to }]),
  })
}

// 强制空视口：光标 fallback 分支的唯一触发口径。不能用“真实构造后不 stub”——
// CM 的 ViewState 构造时就计算 visibleRanges（实测挂载即非空，如 [{0, 961}]），
// 那样测试走的是正常分支，删掉 fallback 依旧全绿。
function clearVisible(view: EditorView) {
  Object.defineProperty(view, "visibleRanges", { configurable: true, value: Object.freeze([]) })
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

const pendingOf = (view: EditorView) => view.state.field(livePreviewField).pending
const covers = (pending: { from: number; to: number }[], pos: number) =>
  pending.some(range => range.from <= pos && pos <= range.to)

// 记录驱动 dispatch 的 liveBuildChunk 区间（按 dispatch 顺序）与 dispatch 次数：
// 驱动行为的直接观测点，只看最终 state 测不到“顺序 / 单交易”语义。
// TransactionSpec.effects 允许单 effect 或数组（ParseWorker 用单值），统一成数组。
function recordChunks(view: EditorView) {
  const original = view.dispatch.bind(view)
  const chunks: { from: number; to: number }[] = []
  let dispatches = 0
  vi.spyOn(view, "dispatch").mockImplementation((...specs: TransactionSpec[]) => {
    dispatches++
    for (const spec of specs) {
      const effects = spec.effects ?? []
      for (const effect of Array.isArray(effects) ? effects : [effects]) {
        if (effect.is(liveBuildChunk)) chunks.push(effect.value)
      }
    }
    original(...specs)
  })
  return { chunks, dispatchCount: () => dispatches }
}

// performance.now 桩：每次调用推进一个预算周期 → 每个 idle 回调恰好构建 1 片。
// 真实每片耗时随机器负载波动（repo 规则：测试必须构造性确定，禁止负载敏感），
// 步进时钟把“每回调一片”变成与耗时无关的确定行为。
function stepClock() {
  let now = 0
  return vi.spyOn(performance, "now").mockImplementation(() => (now += LIVE_BUILD_SLICE_MS))
}

// 步进到驱动再构建 n 片：advanceTimersToNextTimer 每次恰好触发一个定时器
// （idle 回调链每轮重排一个 0ms 定时器；advanceTimersByTime 对“同 tick 内
// 重排的 0ms 定时器”的触发行为不一致，不可用）。上限保护只防杂散定时器
// 死循环，不依赖真实耗时。
function tickUntilChunks(recorded: { chunks: { from: number; to: number }[] }, count: number) {
  for (let guard = 0; recorded.chunks.length < count && guard < 10 * count + 20; guard++) {
    vi.advanceTimersToNextTimer()
  }
  expect(recorded.chunks.length).toBe(count)
}

describe("live build driver", () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("exports the driver scheduling constants", () => {
    expect(LIVE_BUILD_SLICE_MS).toBe(24)
    expect(LIVE_IDLE_TIMEOUT_MS).toBe(200)
    expect(LIVE_BUILD_CHUNK_CHARS).toBe(262_144)
  })

  it("builds pending visible ranges in the first microtask pass", async () => {
    vi.useFakeTimers()
    const doc = boldDoc(1000)
    const { view, cleanup } = mountView(doc)          // 光标 0 → 尾部单段 pending
    expect(pendingOf(view)).toHaveLength(1)
    const visibleFrom = view.state.doc.line(600).from
    setVisible(view, visibleFrom, visibleFrom + 30)
    const { chunks, dispatchCount } = recordChunks(view)

    // 构造期不 dispatch：首帧通道在微任务里（禁止 update 内同步 dispatch）
    expect(chunks).toEqual([])
    await Promise.resolve()
    expect(chunks).toEqual([{ from: visibleFrom, to: visibleFrom + 29 }])
    expect(dispatchCount()).toBe(1)
    expect(covers(pendingOf(view), visibleFrom)).toBe(false)
    expect(view.state.field(livePreviewField).specs
      .some(spec => spec.from >= visibleFrom)).toBe(true)
    cleanup()
  })

  it("carries every visible slice in one transaction", async () => {
    vi.useFakeTimers()
    const doc = boldDoc(1000)
    const { view, cleanup } = mountView(doc)
    const first = view.state.doc.line(600)
    const second = view.state.doc.line(650)
    // 两个不相交的可见段（如折叠区间隔开的视口）→ 一笔交易携带全部 effect
    Object.defineProperty(view, "visibleRanges", {
      configurable: true,
      value: Object.freeze([
        { from: first.from, to: first.to + 1 },
        { from: second.from, to: second.to + 1 },
      ]),
    })
    const { chunks, dispatchCount } = recordChunks(view)
    await Promise.resolve()
    expect(dispatchCount()).toBe(1)
    expect(chunks).toEqual([
      { from: first.from, to: first.to },
      { from: second.from, to: second.to },
    ])
    cleanup()
  })

  it("exhausts the pending range nearest the viewport before the farther one", async () => {
    vi.useFakeTimers()
    stepClock()
    const doc = boldDoc(1000)
    const mid = Math.floor(doc.length / 2)
    const { view, cleanup } = mountView(doc, mid)     // 种子居中 → 头尾两段 pending
    const [head, tail] = pendingOf(view)
    expect(head.to).toBeLessThan(mid)
    expect(tail.from).toBeGreaterThan(mid)
    // 视口锚定在种子内、贴近 head：head 距视口 ~150 行，tail 距 ~450 行
    const visibleFrom = view.state.doc.line(350).from
    setVisible(view, visibleFrom, visibleFrom + 5)
    const { chunks } = recordChunks(view)

    await Promise.resolve()                            // 首帧通道：视口在种子内 → 无活
    expect(chunks).toEqual([])
    tickUntilChunks({ chunks }, 1)                     // idle 回调 1：最近的 head 整段消耗
    expect(pendingOf(view)).toEqual([tail])
    expect(chunks).toEqual([{ from: head.from, to: head.to }])
    tickUntilChunks({ chunks }, 2)                     // idle 回调 2：只剩 tail
    expect(pendingOf(view)).toEqual([])
    expect(chunks[1]).toEqual({ from: tail.from, to: tail.to })
    cleanup()
  })

  it("slices at most LIVE_BUILD_CHUNK_CHARS from the endpoint nearest the viewport", async () => {
    vi.useFakeTimers()
    stepClock()
    const doc = plainDoc(4000, 200)                    // ≈ 800k 字符，pending ≈ 740k
    const { view, cleanup } = mountView(doc)           // 种子 ~60k（行半径先命中）
    const [pending] = pendingOf(view)
    expect(pending.to - pending.from + 1).toBeGreaterThan(2 * LIVE_BUILD_CHUNK_CHARS)

    // 视口在种子内、贴近 pending.from → 从 from 端切一片
    setVisible(view, pending.from - 100, pending.from - 50)
    const { chunks } = recordChunks(view)
    await Promise.resolve()                            // 首帧通道：视口不与 pending 相交
    expect(chunks).toEqual([])
    tickUntilChunks({ chunks }, 1)
    expect(chunks).toEqual([{ from: pending.from, to: pending.from + LIVE_BUILD_CHUNK_CHARS - 1 }])
    expect(pendingOf(view)).toEqual([
      { from: pending.from + LIVE_BUILD_CHUNK_CHARS, to: pending.to },
    ])

    // 视口滚到文末（落在 pending 内）：无需取消在途回调，下一回调按新视口
    // 改从 to 端切 —— 视口变化重排优先级
    setVisible(view, view.state.doc.length - 20, view.state.doc.length)
    tickUntilChunks({ chunks }, 2)
    expect(chunks[1]).toEqual({ from: pending.to - LIVE_BUILD_CHUNK_CHARS + 1, to: pending.to })
    expect(pendingOf(view)).toEqual([
      { from: pending.from + LIVE_BUILD_CHUNK_CHARS, to: pending.to - LIVE_BUILD_CHUNK_CHARS },
    ])
    cleanup()
  })

  it("consumes a point pending range left by a full-region deletion", async () => {
    vi.useFakeTimers()
    stepClock()
    const doc = boldDoc(1000)
    const { view, cleanup } = mountView(doc)
    const [pending] = pendingOf(view)
    // 删除 pending 前一字符到文末：pending 塌缩为删除点上的单点区间（合法目标）
    view.dispatch({ changes: { from: pending.from - 1, to: view.state.doc.length } })
    const point = pending.from - 1
    expect(pendingOf(view)).toEqual([{ from: point, to: point }])

    setVisible(view, 0, 10)                            // 视口在种子内，与点不相交
    const { chunks } = recordChunks(view)
    await Promise.resolve()
    expect(chunks).toEqual([])
    tickUntilChunks({ chunks }, 1)
    expect(chunks).toEqual([{ from: point, to: point }])
    expect(pendingOf(view)).toEqual([])
    cleanup()
  })

  it("falls back to the cursor when visibleRanges is empty", async () => {
    vi.useFakeTimers()
    stepClock()
    const doc = plainDoc(4000, 200)                    // ≈ 800k 字符
    const { view, cleanup } = mountView(doc, doc.length) // 光标文末 → pending 单段 ~740k
    const [pending] = pendingOf(view)                  // 消耗前快照区间（之后即排空）
    expect(pending.to - pending.from + 1).toBeGreaterThan(LIVE_BUILD_CHUNK_CHARS)
    clearVisible(view)                                 // 空视口 → 锚点退化为光标点
    const { chunks } = recordChunks(view)
    await Promise.resolve()                            // 光标点在种子内 → 首帧无活
    expect(chunks).toEqual([])
    tickUntilChunks({ chunks }, 1)
    // 光标贴近 pending.to → 从 to 端切一片：区分 fallback 与“恒取首区间首端”
    expect(chunks).toEqual([{ from: pending.to - LIVE_BUILD_CHUNK_CHARS + 1, to: pending.to }])
    expect(pendingOf(view)).toEqual([
      { from: pending.from, to: pending.to - LIVE_BUILD_CHUNK_CHARS },
    ])
    cleanup()
  })

  it("stops dispatching after view.destroy()", async () => {
    vi.useFakeTimers()
    stepClock()
    const doc = boldDoc(1000)
    const { view, cleanup } = mountView(doc)
    setVisible(view, 0, 10)                            // 视口在种子内：仅空闲循环干活
    const { chunks, dispatchCount } = recordChunks(view)
    await Promise.resolve()
    tickUntilChunks({ chunks }, 1)
    const dispatched = chunks.length
    const dispatches = dispatchCount()
    expect(dispatches).toBeGreaterThan(0)              // destroy 前正常分片

    view.destroy()                                     // 在途 idle 回调被取消
    vi.runAllTimers()
    await Promise.resolve()
    expect(dispatchCount()).toBe(dispatches)           // destroy 后不再 dispatch
    expect(chunks.length).toBe(dispatched)
    cleanup()
  })

  it("ignores the queued first pass when destroyed before it runs", async () => {
    vi.useFakeTimers()
    const doc = boldDoc(1000)
    const { view, parent } = mountView(doc)
    const visibleFrom = view.state.doc.line(600).from
    setVisible(view, visibleFrom, visibleFrom + 30)    // 视口在 pending 内：微任务想构建
    const { dispatchCount } = recordChunks(view)
    view.destroy()                                     // 微任务不可取消 → 依赖 stopped 门闩
    parent.remove()
    await Promise.resolve()
    vi.runAllTimers()
    expect(dispatchCount()).toBe(0)
  })

  it("prefers requestIdleCallback with a timeout and cancels it on destroy", async () => {
    const idleCallbacks: Array<{ callback: () => void; options: { timeout: number } }> = []
    const cancelled: number[] = []
    const ric = vi.fn((callback: () => void, options: { timeout: number }) => {
      idleCallbacks.push({ callback, options })
      return 7
    })
    const cic = vi.fn((handle: number) => { cancelled.push(handle) })
    const idleGlobal = globalThis as Record<string, unknown>
    Object.defineProperty(idleGlobal, "requestIdleCallback", { configurable: true, value: ric })
    Object.defineProperty(idleGlobal, "cancelIdleCallback", { configurable: true, value: cic })
    try {
      const doc = boldDoc(1000)
      const { view, cleanup } = mountView(doc)
      setVisible(view, 0, 10)                          // 首帧无活 → 只挂 idle 调度
      await Promise.resolve()
      expect(ric).toHaveBeenCalledTimes(1)
      expect(idleCallbacks[0].options).toEqual({ timeout: LIVE_IDLE_TIMEOUT_MS })
      view.destroy()
      expect(cancelled).toEqual([7])
      cleanup()
    } finally {
      delete idleGlobal.requestIdleCallback
      delete idleGlobal.cancelIdleCallback
    }
  })

  it("drains again after a live/source round trip re-seeds pending", async () => {
    vi.useFakeTimers()
    stepClock()
    const doc = boldDoc(1000)
    const { view, cleanup } = mountView(doc)
    setVisible(view, 0, 10)
    const { chunks } = recordChunks(view)
    await Promise.resolve()
    vi.runAllTimers()                                  // 排空 → 循环自停
    expect(pendingOf(view)).toEqual([])
    expect(chunks).toHaveLength(1)                     // 整段 pending < 单片上限

    // 切到源码再切回 Live：compartment 重建 field（种子 → pending 非空），
    // 新驱动实例经构造/update 重新武装，恢复分片
    view.dispatch(setLivePreview(false))
    expect(view.state.field(livePreviewField, false)).toBeUndefined()
    view.dispatch(setLivePreview(true))
    expect(pendingOf(view)).toHaveLength(1)
    await Promise.resolve()
    vi.runAllTimers()
    expect(pendingOf(view)).toEqual([])
    expect(chunks).toHaveLength(2)                     // 每轮排空恰好一片
    cleanup()
  })
})
