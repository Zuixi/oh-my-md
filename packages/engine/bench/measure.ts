import { EditorState, type StateEffect } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { forceParsing } from "@codemirror/language"
import { editorExtensions, buildTextFromChunks } from "../src/index"
import {
  buildLiveDecorations,
  LIVE_BUILD_CHUNK_CHARS,
  liveBuildChunk,
  livePreviewField,
  livePruneOutside,
  mergeRanges,
  seedLiveDecorations,
} from "../src/decorations/build"
import { setLivePreview } from "../src/modes/livePreview"
import { documentStats } from "../src/stats"
import { LIVE_PRUNE_MARGIN_CHARS, LIVE_WINDOW_CHARS } from "../src/safeModeRendering"

export const TYPING_P95_BUDGET_MS = 16
export const STATS_BUDGET_MS = 8
// ⌘E 切 Live 的切换预算（source→live = compartment reconfigure + 光标种子构建，
// 成本以 LIVE_SEED_RADIUS_* 为界）：Task 1 前该路径是全量装饰构建（50MB 级秒级
// 冻结），100ms 是「切换无感」的宽松上限，两档大文档都应远低于此。
export const TOGGLE_SEED_BUDGET_MS = 100

export interface TypingLatency { p50Ms: number; p95Ms: number; samples: number }

export interface LiveToggleLatency { toggleP95Ms: number; seedP95Ms: number; samples: number }

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, idx)]
}

function baseState(doc: string): EditorState {
  return EditorState.create({ doc, extensions: editorExtensions() })
}

/** 在文档中部连续逐键输入，度量每笔事务耗时（含增量重解析+装饰更新）。
 *
 * tree 口径（Spec 05a §10.4）：
 * - "steady"（默认）= 生产稳态：只解析到 viewport.to + 100000（镜像 CM idle worker
 *   的 Work.MaxParseAhead），大文档永远保持部分树 —— 实测 10MB/38 万行逐键 p95 1.5ms。
 * - "complete" = worst-case 上限参考：全树解析后每键的 fragment 重启随文档规模增长
 *   （1MB=23.5ms、10MB=70.6ms）。生产代码禁止制造该状态
 *   （apps/desktop/test/crossLayerNoFullTree.test.ts 护栏）。 */
export function measureTyping(
  doc: string,
  opts: {
    keystrokes?: number
    mode?: "live" | "source"
    tree?: "steady" | "complete"
    /** 安全模式窗口化稳态（Task 3，需 mode:"live"）：逐键前先把「窗口内已建、
     * 窗口外归还 pending」落位（见 syncSafeWindowReady），度量窗口为界的
     * 每键装饰映射成本。 */
    safeWindow?: boolean
  } = {},
): TypingLatency {
  const count = opts.keystrokes ?? 200
  const mode = opts.mode ?? "live"
  const tree = opts.tree ?? "steady"
  let state = baseState(doc)
  if (mode === "source") state = state.update(setLivePreview(false)).state
  const parent = document.createElement("div")
  document.body.appendChild(parent)
  const view = new EditorView({ state, parent })
  forceParsing(view, tree === "complete" ? doc.length : view.viewport.to + 100000, 60000)
  // 窗口化稳态：生产由 liveBuildDriver 的微任务/idle 通道推进，而 bench 的同步
  // 度量循环期间那些回调不会运行 —— 同步落位等价稳态后再逐键。
  if (opts.safeWindow) syncSafeWindowReady(view)
  let pos = Math.floor(doc.length / 2)
  const samples: number[] = []
  for (let i = 0; i < count; i++) {
    const t0 = performance.now()
    view.dispatch({ changes: { from: pos, insert: "字" }, selection: { anchor: pos + 1 } })
    samples.push(performance.now() - t0)
    pos += 1
  }
  view.destroy()
  parent.remove()
  const sorted = [...samples].sort((a, b) => a - b)
  return { p50Ms: percentile(sorted, 50), p95Ms: percentile(sorted, 95), samples: count }
}

/** 冷启动：建 state + 挂 view + 强制整树解析的总耗时。 */
export function measureColdParseMs(doc: string): number {
  const t0 = performance.now()
  const parent = document.createElement("div")
  document.body.appendChild(parent)
  const view = new EditorView({ state: baseState(doc), parent })
  forceParsing(view, doc.length, 60000)
  const ms = performance.now() - t0
  view.destroy()
  parent.remove()
  return ms
}

/** 完整树状态下整文档装饰重建（buildLiveDecorations）耗时。 */
export function measureDecoRebuildMs(state: EditorState): number {
  const t0 = performance.now()
  buildLiveDecorations(state)
  return performance.now() - t0
}

export function measureStatsMs(doc: string): number {
  const t0 = performance.now()
  documentStats(doc)
  return performance.now() - t0
}

/** ⌘E 切 Live 的模式切换悬崖（本计划 Task 1 的动机场景）：source 稳态（挂 view、
 * steady 部分树，与 measureTyping 主口径一致）下切 Live，度量整笔切换交易的
 * 引擎成本。Task 1 前 reconfigure 即全量构建整篇装饰（50MB 级秒级冻结）；现在
 * = compartment reconfigure + 光标附近种子构建，成本以 LIVE_SEED_RADIUS_* 为
 * 界、与文档规模解耦 —— 各档数字应基本持平即验证成功。
 * 注意 StateField 值为惰性求值（槽位缓存在首次读取时才填充，非近期版本行为）：
 * state.update 本身不触发种子构建，
 * 真实 ⌘E 中种子发生在 view 更新读取装饰 facet 时 —— 故计时区间为 update +
 * field 读取（强制求值），与生产 dispatch 的实际工作量一致。同一 source state
 * 上重复采样（update 产生独立新 state，不回写 view），另单独度量
 * seedLiveDecorations 纯函数耗时作对照。 */
export function measureLiveToggleMs(doc: string): LiveToggleLatency {
  const source = EditorState.create({ doc, extensions: editorExtensions({ defaultLivePreview: false }) })
  const parent = document.createElement("div")
  document.body.appendChild(parent)
  const view = new EditorView({ state: source, parent })
  forceParsing(view, view.viewport.to + 100000, 60000)
  const steady = view.state
  const toggleSamples: number[] = []
  const seedSamples: number[] = []
  const count = 8
  for (let i = 0; i < count; i++) {
    let t0 = performance.now()
    steady.update(setLivePreview(true)).state.field(livePreviewField)
    toggleSamples.push(performance.now() - t0)
    t0 = performance.now()
    seedLiveDecorations(steady)
    seedSamples.push(performance.now() - t0)
  }
  view.destroy()
  parent.remove()
  return {
    toggleP95Ms: percentile([...toggleSamples].sort((a, b) => a - b), 95),
    seedP95Ms: percentile([...seedSamples].sort((a, b) => a - b), 95),
    samples: count,
  }
}

/** 安全模式窗口化稳态的确定性就绪（bench 专用）：同步复刻 liveBuildDriver 的
 * 收敛稳态 —— windowedFirstPass（可见区分片）叠加 idle 分片循环把构建窗口内
 * pending 排空后的净效果：pending∩构建窗口（可见段 ± LIVE_WINDOW_CHARS）按
 * LIVE_BUILD_CHUNK_CHARS 切片并入同一笔 liveBuildChunk 交易，并随交易 dispatch
 * livePruneOutside（裁剪窗口 = 构建窗口再叠 LIVE_PRUNE_MARGIN_CHARS 迟滞；驱动
 * 仅在确有窗口外装饰时附带该 effect，此处直接携带，无窗口外装饰时为无活 no-op）。
 * bench 的同步度量循环期间微任务/idle 回调不会运行（驱动无法推进），故由本函数
 * 直接落位稳态；窗口算式与 buildDriver 同构（可见段先 mergeRanges 归并再外扩，
 * 避免多段可见区产出重叠分片；无布局宿主可见段退化为文档头小段，确定性）。
 * 树只覆盖 steady 区间：窗口内树未及的部分收不到 specs、仅移出 pending，
 * 与驱动路径行为一致。 */
export function syncSafeWindowReady(view: EditorView): void {
  const live = view.state.field(livePreviewField, false)
  if (!live) return
  const length = view.state.doc.length
  const clamp = (n: number) => Math.max(0, Math.min(length, n))
  const ranges = view.visibleRanges
  const visible = ranges.length > 0
    ? ranges.map(range => ({ from: range.from, to: Math.max(range.from, range.to - 1) }))
    : [{ from: view.state.selection.main.head, to: view.state.selection.main.head }]
  const expand = (margin: number) => mergeRanges(visible.map(region => ({
    from: clamp(region.from - margin),
    to: clamp(region.to + margin),
  })))
  const effects: StateEffect<unknown>[] = []
  for (const region of expand(LIVE_WINDOW_CHARS)) {
    for (const range of live.pending) {
      const from = Math.max(range.from, region.from)
      const to = Math.min(range.to, region.to)
      for (let start = from; start <= to; start += LIVE_BUILD_CHUNK_CHARS) {
        effects.push(liveBuildChunk.of({ from: start, to: Math.min(to, start + LIVE_BUILD_CHUNK_CHARS - 1) }))
      }
    }
  }
  effects.push(livePruneOutside.of(expand(LIVE_WINDOW_CHARS + LIVE_PRUNE_MARGIN_CHARS)))
  view.dispatch({ effects })
}

export function budgetLine(name: string, ms: number, budgetMs: number): string {
  const verdict = ms <= budgetMs ? "OK" : `OVER BUDGET (> ${budgetMs}ms)`
  return `${name}: ${ms.toFixed(2)}ms — ${verdict}`
}

// 供 bench 用例拿到"完整树"状态：live 模式（装饰重建在 live 下才有意义）。
export function fullyParsedLiveState(doc: string): EditorState {
  const parent = document.createElement("div")
  document.body.appendChild(parent)
  const view = new EditorView({ state: baseState(doc), parent })
  forceParsing(view, doc.length, 60000)
  const state = view.state
  view.destroy()
  parent.remove()
  return state
}

/** Spec 05b 冷打开口径：字符串 ingest（EditorState.create 切行）+ view 挂载
 * + 首屏视口解析（steady 树，不推到 doc.length）。不含 IPC/读盘——那两段
 * 由 Rust 命令与 Channel 承担，engine bench 度量主线程的最后一跳。
 * mode="live"（Task 5）：live 构造 + 挂载首帧 —— 挂载时装饰 facet 首次读取
 * 强制 livePreviewField 求值（Task 1 后 = 光标种子构建，不再全量；剩余区间
 * 由 idle 分片消化，不在此同步边界内）。source 档保持历史构造（live 创建 +
 * 切 source；字段惰性求值下创建与切换都不触发种子，等价于直接 source 构造）。 */
export function measureOpenIngestMs(doc: string, mode: "source" | "live" = "source"): number {
  const t0 = performance.now()
  const state = EditorState.create({ doc, extensions: editorExtensions() })
  return mountedIngestMs(t0, state, mode)
}

/** Task 10 对照口径：IPC 分块（字符串形态）→ 分块切行组 Text → Text 构造
 * state + 挂载。与 measureOpenIngestMs 的字符串路径唯一差异是 doc 来源 ——
 * EditorState.create 收到 Text 即跳过对整串的 regex 切行。 */
export function measureOpenIngestChunksMs(
  chunks: readonly string[],
  mode: "source" | "live" = "source",
): number {
  const t0 = performance.now()
  const state = EditorState.create({ doc: buildTextFromChunks(chunks), extensions: editorExtensions() })
  return mountedIngestMs(t0, state, mode)
}

/** 切行/组 rope 助手单独计时（不含 state 构造与挂载），量度摄入路径的可剥离收益。 */
export function measureChunkedTextBuildMs(chunks: readonly string[]): number {
  const t0 = performance.now()
  buildTextFromChunks(chunks)
  return performance.now() - t0
}

function mountedIngestMs(t0: number, state: EditorState, mode: "source" | "live"): number {
  const mounted = mode === "live" ? state : state.update(setLivePreview(false)).state
  const parent = document.createElement("div")
  document.body.appendChild(parent)
  const view = new EditorView({ state: mounted, parent })
  // Teardown is O(doc) DOM work and not part of the open budget — stop the
  // clock before destroy so teardown cost cannot pollute the tier budgets.
  const elapsed = performance.now() - t0
  view.destroy()
  parent.remove()
  return elapsed
}
