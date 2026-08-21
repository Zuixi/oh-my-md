import { type StateEffect } from "@codemirror/state"
import { type EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view"
import {
  LIVE_BUILD_CHUNK_CHARS,
  type LiveDeco,
  liveBuildChunk,
  livePreviewField,
  livePruneOutside,
  mergeRanges,
} from "./build"
import {
  LIVE_PRUNE_MARGIN_CHARS,
  LIVE_WINDOW_CHARS,
  safeModeRenderingEnabled,
} from "../safeModeRendering"

// 分片驱动（Task 2）：livePreviewField 只同步构建光标附近的种子区间，其余记入
// LiveDeco.pending。本插件在微任务/idle 回调里逐片 dispatch liveBuildChunk 消耗
// pending，让 50MB 级文档 Ctrl+E 进 Live 后渐进渲染而不是首帧冻结：
//   1. 微任务首帧通道：构造/更新后发现 pending 非空，先同步构建当前视口覆盖的
//      pending 部分（单交易多 effect），保证切换后首屏可见区立即有装饰。
//   2. 空闲分片循环：requestIdleCallback（无则 setTimeout，happy-dom 兼容）每回调
//      挑「距视口最近的 pending 区间」、从靠视口一端切 ≤LIVE_BUILD_CHUNK_CHARS 一片，
//      按墙钟预算 LIVE_BUILD_SLICE_MS 连续构建若干片后重新调度让出主线程。
//   3. 安全模式窗口化（Task 3，safeModeRenderingEnabled() 开启）：不再排空到全量
//      —— idle 循环只构建「构建窗口」（视口 ± LIVE_WINDOW_CHARS）内的 pending，
//      窗口外的留在 pending 待滚动进入；每次视口/文档/选区变化后的首帧通道同时
//      dispatch livePruneOutside：完全落在「裁剪窗口」（构建窗口再叠
//      LIVE_PRUNE_MARGIN_CHARS 迟滞裕量）外的已建装饰归还 pending，滚回时重建。
//      装饰内存与每笔编辑的映射成本都以窗口为界。开关关闭时行为与 Task 2 完全一致。
// 禁止在 ViewPlugin.update 内直接 dispatch（CodeMirror 限制）——所有 dispatch 都经
// 微任务/idle 回调。视口变化无需取消在途回调：每片都用最新 view.visibleRanges 重选。

// 单次 idle 回调的墙钟工作预算（ms）。每片构建成本随内容密度波动，按墙钟切片比
// 按片数切片更能守住帧节奏；预算内至少构建一片，保证驱动总有进度。
export const LIVE_BUILD_SLICE_MS = 24

// requestIdleCallback 的超时兜底：主线程持续繁忙时也保证最低调度频率。
export const LIVE_IDLE_TIMEOUT_MS = 200

/** 闭区间 [from, to]（与 LiveDeco.pending 同口径，from <= to，点区间合法）。 */
interface ClosedRange {
  from: number
  to: number
}

interface IdleGlobal {
  requestIdleCallback?: (callback: () => void, options: { timeout: number }) => number
  cancelIdleCallback?: (handle: number) => void
}

// 空闲调度统一入口：浏览器走 requestIdleCallback（timeout 保证最终触发），
// happy-dom 等宿主无此 API 时退化为 setTimeout(0)。返回取消函数供 destroy 清理。
function scheduleIdle(callback: () => void): () => void {
  const idle = globalThis as IdleGlobal
  if (typeof idle.requestIdleCallback === "function" && typeof idle.cancelIdleCallback === "function") {
    const handle = idle.requestIdleCallback(callback, { timeout: LIVE_IDLE_TIMEOUT_MS })
    return () => idle.cancelIdleCallback?.(handle)
  }
  const handle = setTimeout(callback, 0)
  return () => clearTimeout(handle)
}

// 视口锚点：CM 的 visibleRanges 是半开 [from, to)，统一转闭区间参与距离/交计算。
// 空列表兜底（防御）：当前实现挂载即算出非空 spans，但类型契约并不承诺非空
// （极端布局/隐藏等边缘状态可能一段都不产）；空时退化为光标点，驱动仍有确定的
// 优先级锚点 —— 光标附近正是种子已构建区，首帧通道通常无活，不构成额外开销。
function visibleRegions(view: EditorView): ClosedRange[] {
  const ranges = view.visibleRanges
  if (ranges.length > 0) {
    return ranges.map(range => ({ from: range.from, to: Math.max(range.from, range.to - 1) }))
  }
  const head = view.state.selection.main.head
  return [{ from: head, to: head }]
}

// 窗口区域：各可见段两侧各扩 margin 字符（闭区间，钳制到 [0, doc.length]），
// 经 mergeRanges 归并相邻/重叠段（两个可见段间距 < 2×margin 时会重叠）。安全
// 模式的构建窗口（LIVE_WINDOW_CHARS）与裁剪窗口（再叠 LIVE_PRUNE_MARGIN_CHARS
// 迟滞裕量）共用此形状。
function expandedRegions(view: EditorView, margin: number): ClosedRange[] {
  const length = view.state.doc.length
  return mergeRanges(visibleRegions(view).map(region => ({
    from: Math.max(0, region.from - margin),
    to: Math.min(length, region.to + margin),
  })))
}

// pending 与窗口区域的交集（闭区间裁剪）：安全模式下驱动只构建窗口内的 pending
// 部分，窗口外的留在 pending 待滚动进入（稳态，不构成调度理由）。
function pendingInWindow(pending: ClosedRange[], window: ClosedRange[]): ClosedRange[] {
  const clipped: ClosedRange[] = []
  for (const range of pending) {
    for (const region of window) {
      const from = Math.max(range.from, region.from)
      const to = Math.min(range.to, region.to)
      if (from <= to) clipped.push({ from, to })
    }
  }
  return clipped
}

// 闭区间 [from, to] 是否完全落在所有窗口区域之外（与任一区域相交即算窗口内）。
// 裁剪门槛用：specs 按 from 有序，但多段窗口存在间隙，O(1) 首尾包络检查会漏掉
// 间隙内的装饰，这里按装饰逐个精确判定（安全模式下 specs 以窗口为界，代价有界）。
function outsideAllRegions(from: number, to: number, regions: ClosedRange[]): boolean {
  for (const region of regions) {
    if (from <= region.to && to >= region.from) return false
  }
  return true
}

// 点到闭区间集的最小距离（点在区间内为 0，否则为到最近端点的间隔）。
function pointDistance(pos: number, regions: ClosedRange[]): number {
  let distance = Infinity
  for (const region of regions) {
    if (pos >= region.from && pos <= region.to) return 0
    distance = Math.min(distance, pos < region.from ? region.from - pos : pos - region.to)
  }
  return distance
}

// 两个闭区间的间隔：相交为 0，否则为最近端点间的字符间隔。
function rangeGap(a: ClosedRange, b: ClosedRange): number {
  if (a.from <= b.to && b.from <= a.to) return 0
  return a.to < b.from ? b.from - a.to : a.from - b.to
}

// 挑距视口最近的 pending 区间，并从靠近视口的一端切 ≤LIVE_BUILD_CHUNK_CHARS 一片。
// pending 有序、互不相交（build.ts 映射后 mergeRanges 归一化保证），并列取序最
// 小者、端点并列取 from 端，行为确定。点区间（from === to，整段删除的塌缩残留）
// 是合法构建目标，永不跳过。
function nearestChunk(pending: ClosedRange[], regions: ClosedRange[]): ClosedRange {
  let index = 0
  let best = Infinity
  for (let i = 0; i < pending.length; i++) {
    let distance = Infinity
    for (const region of regions) distance = Math.min(distance, rangeGap(pending[i], region))
    if (distance < best) {
      best = distance
      index = i
      if (distance === 0) break
    }
  }
  const target = pending[index]
  return pointDistance(target.from, regions) <= pointDistance(target.to, regions)
    ? { from: target.from, to: Math.min(target.to, target.from + LIVE_BUILD_CHUNK_CHARS - 1) }
    : { from: Math.max(target.from, target.to - LIVE_BUILD_CHUNK_CHARS + 1), to: target.to }
}

// 首帧通道的目标：各视口区间与 pending 的交集，按 ≤LIVE_BUILD_CHUNK_CHARS 切片。
// visibleRanges 与 pending 各自有序不相交 → 切片间互不相交，可并入同一交易。
// 取舍：单个可见段超过 LIVE_BUILD_CHUNK_CHARS 的 pending 时也一次性切成多片并入
// 同一交易（不逐片让出）——首帧语义优先于分片节奏，可见区必须立即有装饰。
function visibleChunks(pending: ClosedRange[], regions: ClosedRange[]): ClosedRange[] {
  const chunks: ClosedRange[] = []
  for (const region of regions) {
    for (const range of pending) {
      const from = Math.max(range.from, region.from)
      const to = Math.min(range.to, region.to)
      for (let start = from; start <= to; start += LIVE_BUILD_CHUNK_CHARS) {
        chunks.push({ from: start, to: Math.min(to, start + LIVE_BUILD_CHUNK_CHARS - 1) })
      }
    }
  }
  return chunks
}

const hasPerformanceNow =
  typeof performance !== "undefined" && typeof performance.now === "function"

class LiveBuildDriver {
  private stopped = false
  private microtaskScheduled = false
  private idleScheduled = false
  private cancelIdle: (() => void) | null = null
  // 安全模式：需要重查窗口（构建窗口内 pending + 裁剪窗口外装饰）。视口/文档/
  // 选区变化置位；初始 true —— 挂载后首个微任务先做一次窗口检查。生产中滚动由
  // viewportChanged 驱动，窗口锚点是 visibleRegions（光标只在可见区为空时作兜底
  // 锚点，见 visibleRegions）；selectionSet 属保守置位，代价是一次自门槛的微任务。
  // 无布局测试宿主用「stub visibleRanges + 触发一笔交易」模拟。
  private windowDirty = true

  constructor(private readonly view: EditorView) {
    this.arm()
  }

  // 对任意 update 重新检查（docChanged/viewportChanged/selectionSet/reconfigure 都
  // 可能改变 pending、视口或窗口）；arm 自带「已在调度中/已停止/无活」短路，代价
  // O(pending×窗口段数)，安全模式下 pending 区间数有界（mergeRanges 归并）。
  update(update: ViewUpdate) {
    if (
      safeModeRenderingEnabled() &&
      (update.viewportChanged || update.docChanged || update.selectionSet)
    ) {
      this.windowDirty = true
    }
    this.arm()
  }

  destroy() {
    this.stopped = true
    this.idleScheduled = false
    this.cancelIdle?.()
    this.cancelIdle = null
  }

  // 入队微任务的条件：非窗口化 —— pending 非空（Task 2 语义不变）；窗口化 ——
  // 窗口脏（需裁剪/重查）或构建窗口内还有待建 pending。窗口外 pending 是安全
  // 模式稳态（等滚动进入），不构成调度理由 —— 否则每次 update 都空转一个微任务。
  private arm() {
    if (this.stopped || this.microtaskScheduled || this.idleScheduled) return
    const live = this.view.state.field(livePreviewField, false)
    if (safeModeRenderingEnabled()) {
      if (!this.windowDirty) {
        if (!live || live.pending.length === 0) return
        if (pendingInWindow(live.pending, this.buildWindow()).length === 0) return
      }
    } else if (!live || live.pending.length === 0) {
      return
    }
    this.microtaskScheduled = true
    queueMicrotask(() => this.firstPass())
  }

  // 构建窗口：可见段 ± LIVE_WINDOW_CHARS。窗口化下 idle 循环与首帧通道的构建
  // 范围都以此为界（首帧通道取 pending∩可见区，天然在窗口内）。
  private buildWindow(): ClosedRange[] {
    return expandedRegions(this.view, LIVE_WINDOW_CHARS)
  }

  private firstPass() {
    this.microtaskScheduled = false
    if (this.stopped) return
    // 开关运行中切换（desktop 切 tab）：旧窗口维护请求作废，等下一笔交易重查
    if (safeModeRenderingEnabled()) this.windowDirty = false
    const live = this.view.state.field(livePreviewField, false)
    if (!live) return
    if (safeModeRenderingEnabled()) {
      this.windowedFirstPass(live)
      return
    }
    if (live.pending.length === 0) return
    // 先挂 idle 调度再 dispatch：dispatch 触发的 update().arm() 看到 idle 在途，
    // 不会再次入队微任务。
    this.scheduleIdleSlice()
    const chunks = visibleChunks(live.pending, visibleRegions(this.view))
    if (chunks.length > 0) {
      this.view.dispatch({ effects: chunks.map(chunk => liveBuildChunk.of(chunk)) })
    }
  }

  // 窗口化首帧通道（安全模式）：单笔交易携带「可见区分片（⊆ 构建窗口）+ 裁剪
  // 窗口外装饰的归还信号」。pending 为空也照走 —— 排空后滚到远处时，已建装饰
  // 全在窗口外，裁剪是唯一的窗口维护动作。裁剪窗口比构建窗口多
  // LIVE_PRUNE_MARGIN_CHARS（迟滞）：恰好建在窗口边缘的装饰不会因视口小幅往返
  // 在「构建 ↔ 裁剪」间抖动。裁剪门槛逐装饰精确判定（见 outsideAllRegions），
  // 无活时不 dispatch（避免每帧空交易）。
  private windowedFirstPass(live: LiveDeco) {
    // 先挂 idle 调度再 dispatch（与非窗口化路径同构）：scheduleIdleSlice 自门槛，
    // 构建窗口内无待建 pending 时不挂。
    this.scheduleIdleSlice()
    const effects: StateEffect<unknown>[] = []
    const chunks = visibleChunks(live.pending, visibleRegions(this.view))
    for (const chunk of chunks) effects.push(liveBuildChunk.of(chunk))
    const pruneWindow = expandedRegions(
      this.view, LIVE_WINDOW_CHARS + LIVE_PRUNE_MARGIN_CHARS)
    if (live.specs.some(spec => outsideAllRegions(spec.from, spec.to, pruneWindow))) {
      effects.push(livePruneOutside.of(pruneWindow))
    }
    if (effects.length > 0) {
      this.view.dispatch({ effects })
    }
  }

  private scheduleIdleSlice() {
    if (this.stopped || this.idleScheduled) return
    const live = this.view.state.field(livePreviewField, false)
    if (!live || live.pending.length === 0) return
    // 安全模式：构建窗口内无待建 pending 时不再排 idle —— 窗口外 pending 是稳态，
    // 持续重排会形成永不停的定时器链（也让测试的 runAllTimers 无法收敛）。
    if (safeModeRenderingEnabled() &&
      pendingInWindow(live.pending, this.buildWindow()).length === 0) return
    this.idleScheduled = true
    this.cancelIdle = scheduleIdle(() => {
      this.cancelIdle = null
      this.idleSlice()
    })
  }

  // 单次 idle 回调：预算内连续构建若干片，然后清标志重排（pending 空了/字段没了
  // 则自动停）。dispatch 发生在 idleScheduled 仍为 true 期间，update().arm() 不
  // 会插入微任务。窗口化下目标列表是 pending∩构建窗口（裁剪后的剩余部分），
  // 窗口内排空即停 —— 窗口外 pending 留待滚动。
  private idleSlice() {
    if (!this.stopped) {
      const started = hasPerformanceNow ? performance.now() : 0
      for (;;) {
        const live = this.view.state.field(livePreviewField, false)
        if (!live || live.pending.length === 0) break
        const regions = visibleRegions(this.view)
        let chunk: ClosedRange
        if (safeModeRenderingEnabled()) {
          const targets = pendingInWindow(live.pending, this.buildWindow())
          if (targets.length === 0) break
          chunk = nearestChunk(targets, regions)
        } else {
          chunk = nearestChunk(live.pending, regions)
        }
        this.view.dispatch({ effects: [liveBuildChunk.of(chunk)] })
        // 无 performance.now 的环境（极端测试宿主）：退化为每回调 1 片
        if (!hasPerformanceNow || performance.now() - started >= LIVE_BUILD_SLICE_MS) break
      }
    }
    this.idleScheduled = false
    this.scheduleIdleSlice()
  }
}

// 经 livePreviewExt() 挂载（与 livePreviewField 同一 compartment）：
// 切到源码模式时随 compartment 一起销毁，destroy 停止循环并清理在途定时器。
export const liveBuildDriver = ViewPlugin.fromClass(LiveBuildDriver)
