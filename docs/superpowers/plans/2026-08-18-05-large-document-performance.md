# 05 大文档性能 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 Spec 05：可复现基准（10k/50k 行）、消除每键全量工作（stats/查找）、>50k 行安全模式（源码模式默认、块渲染预算、按需字数、一次性提示条）、CI advisory 基准与文档。

**Architecture:** 基准先行（Vitest bench + 确定性文档生成器），行为改动数据驱动且按"预算内不阻断"设计。Spec §2 的其余每键候选已在此前落地、无需任务：outline 已 150ms 防抖且仅在面板开启时计算（App.tsx:743-749），文件树轮询已降为 30s 兜底（notify 驱动日常刷新）。安全模式阈值常量归 engine 所有、desktop 镜像 + drift test；块渲染预算是引擎内全局策略（单窗口应用），由 desktop 在文档载入时按档位设置。规格中"视口 ±1 屏"映射为「距光标行 ≤ 预算行数，或已进入 CM 视口估算」——headless 测试无法依赖 visibleRanges（无布局时视口=整文档），光标距离是可测的确定性信号，滚动接近时经视口判定补渲。

**Tech Stack:** Vitest 3 `vitest bench`、CodeMirror 6 StateEffect/Compartment、React 19 harness 测试。

**Spec:** `docs/superpowers/specs/2026-08-13-05-large-document-performance-design.md`

## Global Constraints

- 常量名与值按规格逐字：`LARGE_DOC_LINES = 30000`、`SAFE_MODE_LINES = 50000`（engine `src/index.ts` 与 desktop `src/constants.ts` 双侧具名 + drift test）。
- typing p95 预算 `< 16ms`；`documentStats` `> 8ms` 必须已按需化；基准在 CI 为 advisory（不阻断：`continue-on-error: true`，>50% 回归仅告警输出）。
- 安全模式不得静默丢功能：提示条说明关闭了什么；性能改动不得移除 live region（`role="status"` 等）。
- 模式切换/选择记忆仅本会话内存（不写 localStorage、不进 session 持久化）。
- 不做：Web Worker 解析、大纲虚拟化、遥测。
- 基准生成器必须确定性（无随机或种子固定），否则 CI 历史对比无意义。
- 提交遵循 `<type>: <why>`；不碰无关工作树改动。

---

### Task 1: engine `setLivePreview` API

**Files:**
- Modify: `packages/engine/src/modes/livePreview.ts`
- Modify: `packages/engine/src/index.ts`（导出 `setLivePreview`）
- Test: `packages/engine/test/modes.test.ts`

**Interfaces:**
- Produces: `setLivePreview(on: boolean): TransactionSpec`（from `@omd/engine`）；`applyToggle` 重构为复用它，行为不变。

- [ ] **Step 1: 写失败测试** —— `test/modes.test.ts` 的 describe 内追加：

```ts
  it("setLivePreview forces an explicit mode without flipping", () => {
    const s0 = stateWith()
    const s1 = s0.update(setLivePreview(false)).state
    expect(mode(s1)).toBe(false)
    const s2 = s1.update(setLivePreview(false)).state
    expect(mode(s2)).toBe(false)
    const s3 = s2.update(setLivePreview(true)).state
    expect(mode(s3)).toBe(true)
  })
```

顶部 import 行改为：

```ts
import {
  livePreviewCompartment, livePreviewExt, isLivePreview, applyToggle, setLivePreview,
} from "../src/modes/livePreview"
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @omd/engine exec vitest run test/modes.test.ts`
Expected: FAIL —— `setLivePreview` 未导出。

- [ ] **Step 3: 实现** —— `src/modes/livePreview.ts` 将 `applyToggle` 替换为：

```ts
export function setLivePreview(on: boolean): TransactionSpec {
  return {
    effects: [
      toggleLivePreview.of(on),
      livePreviewCompartment.reconfigure(on ? livePreviewExt() : []),
    ],
  }
}

export function applyToggle(state: EditorState): TransactionSpec {
  return setLivePreview(!state.field(isLivePreview))
}
```

`src/index.ts` 在 `applyToggle` 的现有导出处（或按字母序）加 `setLivePreview` 导出。

- [ ] **Step 4: 跑测试确认通过** —— Run: `pnpm --filter @omd/engine exec vitest run test/modes.test.ts && pnpm --filter @omd/engine exec tsc --noEmit`
Expected: PASS（含原有三条不回归）。

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/modes/livePreview.ts packages/engine/src/index.ts packages/engine/test/modes.test.ts
git commit -m "feat: add explicit setLivePreview engine API"
```

---

### Task 2: 大文档阈值常量 + drift test

**Files:**
- Modify: `packages/engine/src/index.ts`
- Modify: `apps/desktop/src/constants.ts`
- Test: `apps/desktop/test/crossLayerConstants.test.ts`

**Interfaces:**
- Produces: `LARGE_DOC_LINES`、`SAFE_MODE_LINES`（`@omd/engine` 与 `../src/constants` 双侧同名同值）。

- [ ] **Step 1: 写失败测试** —— `test/crossLayerConstants.test.ts` import 增：

```ts
import { LARGE_DOC_LINES as ENGINE_LARGE_DOC_LINES, SAFE_MODE_LINES as ENGINE_SAFE_MODE_LINES } from "@omd/engine"
import { LARGE_DOC_LINES, SAFE_MODE_LINES } from "../src/constants"
```

（与现有 `../src/constants` import 合并为一个。）describe 内追加：

```ts
  it("large-doc thresholds match engine constants", () => {
    expect(LARGE_DOC_LINES).toBe(ENGINE_LARGE_DOC_LINES)
    expect(SAFE_MODE_LINES).toBe(ENGINE_SAFE_MODE_LINES)
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @omd/desktop exec vitest run test/crossLayerConstants.test.ts`
Expected: FAIL —— 两侧常量均不存在，编译报错。

- [ ] **Step 3: 实现** —— engine `src/index.ts` 顶部（import 之后）：

```ts
// Spec 05：>30k 行提示大文档；>50k 行进入安全模式（desktop 镜像于 constants.ts，
// crossLayerConstants.test.ts 漂移守护）。归 engine 所有：装饰/渲染档位由语义方定义。
export const LARGE_DOC_LINES = 30000
export const SAFE_MODE_LINES = 50000
```

desktop `src/constants.ts` 末尾：

```ts
// Mirrors @omd/engine LARGE_DOC_LINES / SAFE_MODE_LINES (drift-guarded in
// test/crossLayerConstants.test.ts).
export const LARGE_DOC_LINES = 30000
export const SAFE_MODE_LINES = 50000
```

- [ ] **Step 4: 跑测试确认通过** —— Run: `pnpm --filter @omd/desktop exec vitest run test/crossLayerConstants.test.ts && pnpm --filter @omd/desktop exec tsc -p tsconfig.test.json`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/index.ts apps/desktop/src/constants.ts apps/desktop/test/crossLayerConstants.test.ts
git commit -m "feat: shared large-document threshold constants"
```

---

### Task 3: 基准设施（生成器 + 度量 + bench 用例）

**Files:**
- Create: `packages/engine/bench/generate.ts`
- Create: `packages/engine/bench/measure.ts`
- Create: `packages/engine/bench/typing.bench.ts`
- Modify: `packages/engine/package.json`（scripts 增 `bench`）
- Modify: `.gitignore`

**Interfaces:**
- Produces:
  - `makeBenchmarkDoc(lines: number): string`（确定性混合负载）
  - `measureTyping(doc: string, opts: { keystrokes?: number; mode: "live" | "source" }): { p50Ms: number; p95Ms: number; samples: number }`
  - `measureColdParseMs(doc: string): number`、`measureDecoRebuildMs(state: EditorState): number`、`measureStatsMs(doc: string): number`
  - `TYPING_P95_BUDGET_MS = 16`、`STATS_BUDGET_MS = 8`（预算仅 console 告警，不 assert）
  - 命令：`pnpm --filter @omd/engine bench`
- 注：`vitest run`（test 模式）默认不含 `*.bench.ts`，无需改 vitest.config.ts。

- [ ] **Step 1: 写 `bench/generate.ts`**

```ts
// 确定性大文档生成器（Spec 05 §4）：标题/表格/代码块/数学/中英混合段落循环。
// 无随机性 —— CI 与本机产出的文档逐字节一致，历史对比才有意义。
export function makeBenchmarkDoc(lines: number): string {
  const blocks: string[] = []
  let produced = 0
  for (let i = 0; produced < lines; i++) {
    const kind = i % 10
    let block: string
    if (kind === 0) {
      block = `# 标题 ${i}\n\n中文段落 ${i}，包含 **加粗**、[链接](https://example.com/${i}) 与普通文本。`
    } else if (kind === 3) {
      block = `| h${i} | v${i} |\n|---|---|\n| 行${i} | 中文单元格 |\n| 行${i + 1} | another cell |`
    } else if (kind === 6) {
      block = "```ts\nconst value" + i + " = " + i + ";\nfunction fn" + i + "() { return value" + i + " * 2; }\n```"
    } else if (kind === 8) {
      block = "$$\nE_{" + i + "} = mc^2 + " + i + "\n$$"
    } else {
      block = `段落 ${i}：中文正文与 English mixed content，用于逐键输入负载。`
    }
    blocks.push(block)
    produced += block.split("\n").length + 1
  }
  return blocks.join("\n\n")
}
```

- [ ] **Step 2: 写 `bench/measure.ts`**

```ts
import { EditorState } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { forceParsing } from "@codemirror/language"
import { editorExtensions } from "../src/index"
import { buildLiveDecorations, livePreviewField } from "../src/decorations/build"
import { setLivePreview } from "../src/modes/livePreview"
import { documentStats } from "../src/stats"

export const TYPING_P95_BUDGET_MS = 16
export const STATS_BUDGET_MS = 8

export interface TypingLatency { p50Ms: number; p95Ms: number; samples: number }

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, idx)]
}

function baseState(doc: string): EditorState {
  return EditorState.create({ doc, extensions: editorExtensions() })
}

/** 在文档中部连续逐键输入，度量每笔事务耗时（含增量重解析+装饰更新）。 */
export function measureTyping(
  doc: string,
  opts: { keystrokes?: number; mode: "live" | "source" } = { mode: "live" },
): TypingLatency {
  const count = opts.keystrokes ?? 200
  let state = baseState(doc)
  if (opts.mode === "source") state = state.update(setLivePreview(false)).state
  // 与生产一致的完整树起点（有 view 才能强制完整解析，见 known-gotchas）
  const parent = document.createElement("div")
  document.body.appendChild(parent)
  const view = new EditorView({ state, parent })
  forceParsing(view, doc.length, 10000)
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

// 抑制未用告警的类型再导出（livePreviewField 供扩展断言用）
export { livePreviewField }
```

- [ ] **Step 3: 写 `bench/typing.bench.ts`**

```ts
import { bench, describe } from "vitest"
import {
  budgetLine, fullyParsedLiveState, measureColdParseMs,
  measureDecoRebuildMs, measureStatsMs, measureTyping, STATS_BUDGET_MS, TYPING_P95_BUDGET_MS,
} from "./measure"
import { makeBenchmarkDoc } from "./generate"

const DOC_10K = makeBenchmarkDoc(10000)
const DOC_50K = makeBenchmarkDoc(50000)

describe("large document benchmarks (advisory)", () => {
  bench("typing 10k lines (live)", () => {
    const r = measureTyping(DOC_10K, { mode: "live" })
    console.info(budgetLine("typing p95 10k live", r.p95Ms, TYPING_P95_BUDGET_MS))
  })

  bench("typing 10k lines (source)", () => {
    const r = measureTyping(DOC_10K, { mode: "source" })
    console.info(budgetLine("typing p95 10k source", r.p95Ms, TYPING_P95_BUDGET_MS))
  })

  bench("typing 50k lines (source, safe mode)", () => {
    const r = measureTyping(DOC_50K, { mode: "source", keystrokes: 100 })
    console.info(budgetLine("typing p95 50k source", r.p95Ms, TYPING_P95_BUDGET_MS))
  })

  bench("cold parse 10k", () => {
    console.info(`cold parse 10k: ${measureColdParseMs(DOC_10K).toFixed(2)}ms`)
  })

  bench("cold parse 50k", () => {
    console.info(`cold parse 50k: ${measureColdParseMs(DOC_50K).toFixed(2)}ms`)
  })

  bench("decoration rebuild 10k (live)", () => {
    const state = fullyParsedLiveState(DOC_10K)
    console.info(`deco rebuild 10k: ${measureDecoRebuildMs(state).toFixed(2)}ms`)
  })

  bench("documentStats 50k", () => {
    console.info(budgetLine("documentStats 50k", measureStatsMs(DOC_50K), STATS_BUDGET_MS))
  })
})
```

（去掉 `makeBenchmarkDocSafe` 别名 import，直接 `import { makeBenchmarkDoc } from "./generate"`，并从 measure 的 import 列表中删除该名。）

- [ ] **Step 4: 接线与忽略产物** —— `packages/engine/package.json` scripts 增：

```json
    "bench": "vitest bench --run --reporter=verbose"
```

`.gitignore` 增：

```
packages/engine/bench/.last-run.json
```

- [ ] **Step 5: 跑基准确认可用并记录数字**

Run: `pnpm --filter @omd/engine bench`
Expected: 7 个 bench 用例执行完成，日志含 `typing p95 … OK/OVER BUDGET` 行。把控制台输出整段留存（Task 8 写 README 引用）。若 50k 用例超过 60s，把 `keystrokes` 降到 50。

- [ ] **Step 6: 确认 bench 不进测试面** —— Run: `pnpm --filter @omd/engine exec vitest run`
Expected: 288 tests，不含 bench 文件。

- [ ] **Step 7: Commit**

```bash
git add packages/engine/bench packages/engine/package.json .gitignore
git commit -m "test: advisory large-document benchmarks"
```

---

### Task 4: 消除每键全量工作（字数防抖 + 查找 memo）

**Files:**
- Modify: `apps/desktop/src/App.tsx`（`:120` 常量区、`:1556-1557` stats、`:1752-1768` find 渲染区）
- Test: `apps/desktop/test/App.stats.test.tsx`（新建）

**Interfaces:**
- Consumes: `documentStats`（engine）。
- Produces: `STATS_DEBOUNCE_MS = 250`（App.tsx 本地常量，同 `OUTLINE_DEBOUNCE_MS` 先例）；`stats` 计算移到 `deferredDoc` 上（Task 5 在此之上叠安全模式门控）；`collectMatches`/`validateFindPattern` 包进 `useMemo`（行为无差异，护栏为既有套件不回归）。

- [ ] **Step 1: 写失败测试** `apps/desktop/test/App.stats.test.tsx`（harness 头部 vi.mock 块与 `App.diagnostics.test.tsx` 完全相同，复制后追加）：

```tsx
  it("defers word count until typing pauses", async () => {
    vi.useFakeTimers()
    const harness = createAppHarness(editor)
    harness.renderApp()
    const opts = editor.create.mock.calls[0][1] as CreateEditorOptions
    act(() => {
      opts.onDocumentUpdate({
        tabId: 1, documentId: opts.documentId, doc: "hello world",
        docChanged: true, pendingNormalization: null,
      })
    })
    // 防抖窗口内：statusbar 仍显示 0 词（空文档基线）
    expect(document.querySelector(".statusbar")?.textContent).not.toContain("2")
    act(() => { vi.advanceTimersByTime(300) })
    // 防抖到期：显示 "hello world" 的 2 词
    expect(document.querySelector(".statusbar")?.textContent).toContain("2")
  })
```

- [ ] **Step 2: 跑测试确认失败** —— Run: `pnpm --filter @omd/desktop exec vitest run test/App.stats.test.tsx`
Expected: FAIL —— 当前 `documentStats(doc)` 同步执行，防抖窗口内就已显示 2。

- [ ] **Step 3: 实现字数防抖** —— App.tsx 常量区（`OUTLINE_DEBOUNCE_MS` 旁）：

```ts
// documentStats 是全文档逐字符扫描；防抖后离开每键同步路径（Spec 05）。
const STATS_DEBOUNCE_MS = 250
```

`:1556-1557` 的 `const stats = useMemo(() => documentStats(doc), [doc])` 替换为：

```ts
  const [deferredDoc, setDeferredDoc] = useState(doc)
  useEffect(() => {
    const timer = window.setTimeout(() => setDeferredDoc(doc), STATS_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [doc])
  const stats = useMemo(() => documentStats(deferredDoc), [deferredDoc])
```

（`useState`/`useEffect` 若未 import 则补。）

- [ ] **Step 4: 查找扫描 memo 化** —— App.tsx `:1752-1768`（FindReplaceBar 的 props）中内联的 `validateFindPattern(...)` 与 `collectMatches(doc, {...}).length` 提取到 render 前：

```ts
  const findPatternError = useMemo(
    () => findOpen && findRegexMode && findQuery !== ""
      ? validateFindPattern({ query: findQuery, caseSensitive: findCase, regex: true, wholeWord: false })
      : null,
    [findOpen, findRegexMode, findQuery, findCase],
  )
  const matchCount = useMemo(
    () => findOpen
      ? collectMatches(doc, {
        query: findQuery,
        caseSensitive: findCase,
        regex: findRegexMode,
        wholeWord: findWholeWord,
      }).length
      : 0,
    [findOpen, doc, findQuery, findCase, findRegexMode, findWholeWord],
  )
```

props 处改用 `patternError={findPatternError}`、`matchCount={matchCount}`。（`collectMatches` 是全文档正则扫描，之前每次 App render 重算——typing 期间每个 React 提交都会跑一遍；memo 后仅依赖真变化。行为无差异，护栏是 desktop 全套不回归。）

- [ ] **Step 5: 跑测试确认通过** —— Run: `pnpm --filter @omd/desktop test`
Expected: PASS 且全套（含 find 相关既有用例）不回归。

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/App.tsx apps/desktop/test/App.stats.test.tsx
git commit -m "perf: keep full-document scans off the per-keystroke path"
```

---

### Task 5: 安全模式 UX（默认源码 + 提示条 + 按需字数 + 会话记忆）

**Files:**
- Create: `apps/desktop/src/LargeDocBanner.tsx`
- Modify: `apps/desktop/src/App.tsx`（`resetTabDocument` `:538-556`、source 命令 `:1331-1339`、banner 区 `:1732-1741`、StatusBar 渲染 `:1805-1812`、stats 区）
- Modify: `apps/desktop/src/StatusBar.tsx`
- Modify: `apps/desktop/src/i18n/messages/en.ts`、`zh.ts`
- Test: `apps/desktop/test/App.largeDoc.test.tsx`（新建）

**Interfaces:**
- Consumes: `setLivePreview`（Task 1）、`LARGE_DOC_LINES`/`SAFE_MODE_LINES`（Task 2）、Task 4 的 `deferredDoc` stats。
- Produces: StatusBar props 变更为 `stats: { words: number; chars: number } | null` + `onRequestStats?: () => void`（null 时渲染可点击的统计按钮）；App 内 `safeModeChoiceRef = useRef(new Map<number, boolean>())`（tabId → 用户显式模式选择；类型由推断）。

- [ ] **Step 1: 写失败测试** `test/App.largeDoc.test.tsx`（harness vi.mock 块同 `App.diagnostics.test.tsx`，`editor.create` 返回自造的 fakeView 以便断言 dispatch）：

```tsx
import { EditorState } from "@codemirror/state"

const fakeView = {
  state: EditorState.create({ doc: "" }),
  dispatch: vi.fn(),
  focus: vi.fn(),
  destroy: vi.fn(),
  dom: document.createElement("div"),
}
// vi.mock("../src/Editor") 块内：
//   createEditor: () => { editor.create(); return fakeView as unknown as EditorView },
//   resetEditorDocument: (view) => { editor.reset(view) },

function bigDoc(lines: number): string {
  return Array.from({ length: lines }, (_, i) => `line ${i}`).join("\n")
}

function openedSafeModeDoc(harness: ReturnType<typeof createAppHarness>, lines: number) {
  harness.services.readFile = vi.fn(async () => bigDoc(lines))
  // 经 openFile 流（harness 提供的打开入口，或直接调 onOpenFile/pending-open mock）载入
}

// setLivePreview(false) 的 effects[0] 是 toggleLivePreview.of(false)：value 为布尔 false
// （compartment reconfigure 的 effect.value 是扩展数组，不会是布尔）。
// 不 import toggleLivePreview —— engine index 未导出它，按 value 形状断言。
const forcedSourceOff = (calls: unknown[][]) =>
  calls.some(([spec]) => spec?.effects?.[0]?.value === false)
```

用例：

```tsx
  it("forces source mode and shows a one-time banner for >50k-line docs", async () => {
    const harness = createAppHarness(editor)
    openedSafeModeDoc(harness, 50010)
    harness.renderApp()
    await waitFor(() => {
      expect(editor.reset).toHaveBeenCalledWith(fakeView, expect.objectContaining({
        doc: expect.stringContaining("line 50009"),
      }))
    })
    // 安全模式默认源码：resetTabDocument 对 view dispatch 了 setLivePreview(false)
    expect(forcedSourceOff(fakeView.dispatch.mock.calls)).toBe(true)
    expect(document.querySelector(".update-banner-message")?.textContent).toContain("50010")
    expect(document.querySelector(".update-banner-message")?.textContent).toContain("source mode")
  })

  it("keeps the banner informational between 30k and 50k lines without forcing source", async () => {
    const harness = createAppHarness(editor)
    openedSafeModeDoc(harness, 30010)
    harness.renderApp()
    await waitFor(() => {
      expect(document.querySelector(".update-banner-message")?.textContent).toContain("30010")
    })
    expect(document.querySelector(".update-banner-message")?.textContent).not.toContain("source mode")
  })

  it("shows an on-demand count button in safe mode and computes on click", async () => {
    vi.useFakeTimers()
    const harness = createAppHarness(editor)
    openedSafeModeDoc(harness, 50010)
    harness.renderApp()
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Count words" })).toBeTruthy()
    })
    fireEvent.click(screen.getByRole("button", { name: "Count words" }))
    act(() => { vi.advanceTimersByTime(300) })
    expect(document.querySelector(".statusbar")?.textContent).toMatch(/\d+/)
  })

  it("remembers an explicit mode switch for the session", async () => {
    const harness = createAppHarness(editor)
    openedSafeModeDoc(harness, 50010)
    harness.renderApp()
    // 用户手动切回 live（source 命令记录选择）
    openPaletteAndRun("source")
    // 再次载入同 tab（恢复快照同路径）：不再强制 source —— banner 仍提示安全模式档
    fakeView.dispatch.mockClear()
    // （触发 resetTabDocument 的第二次载入后）
    expect(forcedSourceOff(fakeView.dispatch.mock.calls)).toBe(false)
  })
```

（`openPaletteAndRun` 辅助同 `App.diagnostics.test.tsx`。打开文件入口若 harness 未直接暴露，按 `App.quickOpen`/恢复流测试的既有打开方式调用——harness 一定提供（既有测试均能打开文档）。）

- [ ] **Step 2: 跑测试确认失败** —— Run: `pnpm --filter @omd/desktop exec vitest run test/App.largeDoc.test.tsx`
Expected: FAIL —— LargeDocBanner 不存在、无强制 source 逻辑。

- [ ] **Step 3: 实现 `LargeDocBanner.tsx`**（复用 update-banner 样式族）：

```tsx
import { useT } from "./i18n"

export interface LargeDocBannerProps {
  readonly lines: number
  readonly safeMode: boolean
  readonly onDismiss: () => void
}

/** Spec 05：大文档一次性非模态提示。安全模式版本必须说明关闭了什么。 */
export function LargeDocBanner({ lines, safeMode, onDismiss }: LargeDocBannerProps) {
  const t = useT()
  return (
    <div className="update-banner">
      <p className="update-banner-message" role="status">
        {t(safeMode ? "largeDoc.safeMode" : "largeDoc.notice", { lines })}
      </p>
      <div className="update-banner-actions">
        <button type="button" className="update-banner-dismiss" onClick={onDismiss}>
          {t("largeDoc.dismiss")}
        </button>
      </div>
    </div>
  )
}
```

i18n en：

```ts
  "largeDoc.notice": "Large document ({lines} lines). All features stay available.",
  "largeDoc.safeMode": "Very large document ({lines} lines): source mode is on, word count is on demand, and rich blocks render only near the viewport.",
  "largeDoc.dismiss": "OK",
  "statusbar.countWords": "Count words",
```

zh：

```ts
  "largeDoc.notice": "文档较大（{lines} 行），全部功能保持可用。",
  "largeDoc.safeMode": "超大文档（{lines} 行）：已切换到源码模式，字数统计需手动刷新，复杂块渲染延迟到接近视口。",
  "largeDoc.dismiss": "知道了",
  "statusbar.countWords": "统计字数",
```

- [ ] **Step 4: StatusBar 改造**：

```tsx
export function StatusBar(props: {
  stats: { words: number; chars: number } | null
  cursor: string
  mode: string
  normalizationReviewRequired: boolean
  saveStatus: SaveStatus
  onRequestStats?: () => void
}) {
  const t = useT()
  return (
    <div className="statusbar">
      {props.normalizationReviewRequired
        ? <span className="statusbar-review">{t("statusbar.reviewRequired")}</span>
        : null}
      {props.saveStatus !== "idle"
        ? <span className="statusbar-save-status">{saveStatusDisplay(props.saveStatus, t)}</span>
        : null}
      {props.stats
        ? <span>{t("statusbar.wordsChars", { words: props.stats.words, chars: props.stats.chars })}</span>
        : props.onRequestStats
          ? <button type="button" className="statusbar-count" onClick={props.onRequestStats}>
              {t("statusbar.countWords")}
            </button>
          : null}
      <span>{props.cursor}</span>
      <span>{props.mode}</span>
    </div>
  )
}
```

- [ ] **Step 5: App 接线**

1. refs/state（其他 ref 声明旁）：

```ts
  const safeModeChoiceRef = useRef(new Map<number, boolean>())   // tabId → 用户显式选择的 isLivePreview
  const [largeDocNotice, setLargeDocNotice] = useState<{ sessionId: number; lines: number; safeMode: boolean } | null>(null)
  const [statsRequested, setStatsRequested] = useState(0)
```

2. `resetTabDocument` 内 `resetEditorDocument(view, ...)` 成功后、`syncDoc(contents, ...)` 前插入：

```ts
    const lines = contents ? contents.split("\n").length : 0
    if (lines > SAFE_MODE_LINES && safeModeChoiceRef.current.get(nextSession.id) === undefined) {
      try { view.dispatch(setLivePreview(false)) } catch { /* mock views */ }
    }
    setLargeDocNotice(
      lines > SAFE_MODE_LINES
        ? { sessionId: nextSession.id, lines, safeMode: true }
        : lines > LARGE_DOC_LINES
          ? { sessionId: nextSession.id, lines, safeMode: false }
          : null,
    )
    setStatsRequested(0)
```

3. source 命令（`:1331-1339`）在 `view.dispatch(applyToggle(view.state))` 前记录选择：

```ts
        const next = !view.state.field(isLivePreview)
        safeModeChoiceRef.current.set(workspaceRef.current.activeId, next)
        view.dispatch(applyToggle(view.state))
```

（保留原 try/catch 与 setSourceMode。）

4. stats 区（Task 4 之上）：

```ts
  const activeLines = useMemo(() => (deferredDoc ? deferredDoc.split("\n").length : 0), [deferredDoc])
  const safeModeActive = activeLines > SAFE_MODE_LINES
  const stats = useMemo(() => {
    if (safeModeActive && statsRequested === 0) return null
    return documentStats(deferredDoc)
  }, [deferredDoc, safeModeActive, statsRequested])
```

`onRequestStats` 回调：`() => setStatsRequested(n => n + 1)`；`statsRequested` 在 `resetTabDocument` 里随 notice 一起重置为 0。

5. banner 渲染（`transientStatus` 段前）：

```tsx
          {largeDocNotice && largeDocNotice.sessionId === workspace.activeId ? (
            <LargeDocBanner
              lines={largeDocNotice.lines}
              safeMode={largeDocNotice.safeMode}
              onDismiss={() => setLargeDocNotice(null)}
            />
          ) : null}
```

6. StatusBar 渲染改为 `stats={stats} onRequestStats={safeModeActive ? () => setStatsRequested(n => n + 1) : undefined}`（其余 props 不变）。import `SAFE_MODE_LINES`/`LARGE_DOC_LINES`、`setLivePreview`、`LargeDocBanner`。

- [ ] **Step 6: 跑测试确认通过** —— Run: `pnpm --filter @omd/desktop test`
Expected: PASS（新增 4+ 用例 + 全套不回归；crossLayerMenu/updater 等不受影响）。

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/LargeDocBanner.tsx apps/desktop/src/StatusBar.tsx apps/desktop/src/App.tsx apps/desktop/src/i18n/messages/en.ts apps/desktop/src/i18n/messages/zh.ts apps/desktop/test/App.largeDoc.test.tsx
git commit -m "feat: safe mode for very large documents"
```

---

### Task 6: engine 块渲染预算（安全模式懒渲染）

**Files:**
- Create: `packages/engine/src/decorations/renderBudget.ts`
- Modify: `packages/engine/src/decorations/blockWidget.ts`
- Modify: `packages/engine/src/index.ts`（导出 + `editorExtensions` 挂 flusher）
- Test: `packages/engine/test/renderBudget.test.ts`（新建）

**Interfaces:**
- Produces:
  - `setBlockRenderBudget(lines: number): void`（`Infinity` 恢复默认全渲染；engine 拥有 `SAFE_MODE_RENDER_BUDGET_LINES = 60`）
  - `withinRenderBudget(view: EditorView, pos: number): boolean`
  - `renderBudgetFlush()` ViewPlugin（挂进 `editorExtensions()`，doc/selection/viewport 变化时重查挂起块）
- 规格"视口 ±1 屏"的映射：距光标行 ≤ 预算，或已进入 `view.visibleRanges`（无布局环境 visibleRanges 不可依赖，光标距离是确定性信号；滚动接近经视口判定补渲）。

- [ ] **Step 1: 写失败测试** `test/renderBudget.test.ts`（不经 livePreview，直接用 block replace 装饰挂 MarkerWidget，避免 Shiki 开销；`renderInto` 是微任务链，断言前 flush 一拍）：

```ts
import { describe, expect, it } from "vitest"
import { EditorState, RangeSetBuilder } from "@codemirror/state"
import { Decoration, EditorView } from "@codemirror/view"
import { editorExtensions, setBlockRenderBudget } from "../src/index"
import { BlockWidget } from "../src/decorations/blockWidget"

class MarkerWidget extends BlockWidget {
  static readonly rendered: MarkerWidget[] = []
  protected get cssClass() { return "omd-marker" }
  protected renderInto(el: HTMLElement) { MarkerWidget.rendered.push(this); el.textContent = "rendered" }
}

function lineStartOf(doc: string, line: number): number {
  return line === 0 ? 0 : doc.split("\n").slice(0, line).join("\n").length + 1
}

/** 每块占 1 行（`block i`），块间隔 3 行空行 → 块 i 在行 i*4。 */
function viewWithMarkers(blocks: number, cursorLine: number): EditorView {
  const lines: string[] = []
  for (let i = 0; i < blocks; i++) lines.push(`block ${i}`, "", "", "")
  const doc = lines.join("\n")
  const builder = new RangeSetBuilder<Decoration>()
  for (let i = 0; i < blocks; i++) {
    const from = lineStartOf(doc, i * 4)
    const to = from + `block ${i}`.length   // 整行 replace，满足 block 对齐
    builder.add(from, to, Decoration.replace({ widget: new MarkerWidget(`block ${i}`, from), block: true }))
  }
  return new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: lineStartOf(doc, cursorLine) },
      extensions: [editorExtensions(), EditorView.decorations.of(builder.finish())],
    }),
    parent: document.body,
  })
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe("block render budget", () => {
  it("renders every block when the budget is infinite (default)", async () => {
    const view = viewWithMarkers(6, 0)
    await flush()
    expect(MarkerWidget.rendered.length).toBe(6)
    view.destroy()
  })

  it("defers far-from-cursor blocks and renders them when the cursor nears", async () => {
    setBlockRenderBudget(4)
    MarkerWidget.rendered.length = 0
    const view = viewWithMarkers(6, 0)   // 块在行 0/4/8/12/16/20
    await flush()
    expect(MarkerWidget.rendered.length).toBe(2)          // 行 0 与 4（|4-0|<=4）
    view.dispatch({ selection: { anchor: lineStartOf(view.state.doc.toString(), 12) } })
    await flush()
    expect(MarkerWidget.rendered.length).toBe(4)          // 冲洗出行 8 与 12
    view.destroy()
    setBlockRenderBudget(Infinity)
  })

  it("restores eager rendering after clearing the budget", async () => {
    setBlockRenderBudget(1)
    MarkerWidget.rendered.length = 0
    const view = viewWithMarkers(4, 0)
    await flush()
    expect(MarkerWidget.rendered.length).toBeLessThan(4)
    setBlockRenderBudget(Infinity)
    view.dispatch({ selection: { anchor: 0 } })           // 触发 flush，全量补渲
    await flush()
    expect(MarkerWidget.rendered.length).toBe(4)
    view.destroy()
  })
})
```

- [ ] **Step 2: 跑测试确认失败** —— Run: `pnpm --filter @omd/engine exec vitest run test/renderBudget.test.ts`
Expected: FAIL —— `setBlockRenderBudget` 未导出。

- [ ] **Step 3: 实现 `renderBudget.ts`**

```ts
import { EditorView } from "@codemirror/view"
import type { BlockWidget } from "./blockWidget"

// 安全模式渲染预算（Spec 05“视口 ±1 屏”的可测映射）：块 widget 的昂贵渲染
// 只在「距光标行 ≤ 预算」或「已进入 CM 视口估算」时启动；其余挂起，由
// renderBudgetFlush 在 doc/selection/viewport 变化时重查。默认 Infinity 保持
// 现行为。全局策略（单窗口应用）；desktop 在安全模式进入/退出时设置。
export const SAFE_MODE_RENDER_BUDGET_LINES = 60

let budgetLines = Infinity

export function setBlockRenderBudget(lines: number): void {
  budgetLines = lines
}

export function blockRenderBudget(): number {
  return budgetLines
}

export function withinRenderBudget(view: EditorView, pos: number): boolean {
  const budget = budgetLines
  if (!Number.isFinite(budget)) return true
  const doc = view.state.doc
  const cursorLine = doc.lineAt(view.state.selection.main.head).number
  const posLine = doc.lineAt(Math.min(Math.max(pos, 0), doc.length)).number
  if (Math.abs(posLine - cursorLine) <= budget) return true
  return view.visibleRanges.some(range => pos >= range.from && pos <= range.to)
}

export interface PendingRender {
  widget: BlockWidget
  view: EditorView
  pos: number
  start: () => void
}

const pending: Set<PendingRender> = new Set()

export function deferBlockRender(entry: PendingRender): void {
  pending.add(entry)
}

export function dropPendingBlockRender(entry: PendingRender): void {
  pending.delete(entry)
}

export function flushDeferredBlockRenders(): number {
  let started = 0
  for (const entry of [...pending]) {
    if (!entry.widget.isActive()) { pending.delete(entry); continue }
    if (withinRenderBudget(entry.view, entry.pos)) {
      pending.delete(entry)
      entry.start()
      started++
    }
  }
  return started
}

// 挂进 editorExtensions()：光标/文档/视口变化即重查挂起块。
export const renderBudgetFlush = () => EditorView.updateListener.of(update => {
  if (update.docChanged || update.selectionSet || update.viewportChanged) {
    flushDeferredBlockRenders()
  }
})
```

- [ ] **Step 4: BlockWidget 挂起/冲洗接线** —— `blockWidget.ts` 的 `toDOM` 中，把现有

```ts
    Promise.resolve()
      .then(() => this.renderInto(body))
```

链提取为局部 `start`，预算外挂起：

```ts
    const start = () => Promise.resolve()
      .then(() => this.renderInto(body))
      .then(() => {
        if (this.isActive(body)) view.requestMeasure()
      })
      .catch(err => {
        if (!this.isActive(body)) return
        body.classList.add("omd-block-error")
        body.textContent = `⚠ ${err instanceof Error ? err.message : err}\n\n${this.src}`
        view.requestMeasure()
      })
    if (withinRenderBudget(view, this.pos)) start()
    else {
      this.pendingEntry = { widget: this, view, pos: this.pos, start }
      deferBlockRender(this.pendingEntry)
    }
```

类内加字段与 import（`import { deferBlockRender, dropPendingBlockRender, PendingRender, withinRenderBudget } from "./renderBudget"`）：

```ts
  private pendingEntry: PendingRender | null = null
```

`destroy(_dom?)` 末尾追加：

```ts
    if (this.pendingEntry) dropPendingBlockRender(this.pendingEntry)
```

`src/index.ts`：导出 `setBlockRenderBudget`、`blockRenderBudget`、`withinRenderBudget`、`SAFE_MODE_RENDER_BUDGET_LINES`（Task 7 的 desktop 测试需要 `blockRenderBudget()` 读取器）；`editorExtensions()` 数组中 `htmlPaste(),` 后加 `renderBudgetFlush(),`。

- [ ] **Step 5: 跑测试确认通过** —— Run: `pnpm --filter @omd/engine test`
Expected: PASS（新增用例 + 288 不回归；blockwidgets/view 慢用例不受影响——默认 Infinity 时行为逐字节等同）。

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/decorations/renderBudget.ts packages/engine/src/decorations/blockWidget.ts packages/engine/src/index.ts packages/engine/test/renderBudget.test.ts
git commit -m "feat: block render budget for safe mode"
```

---

### Task 7: desktop 安全模式渲染预算接线

**Files:**
- Modify: `apps/desktop/src/App.tsx`（`resetTabDocument` 的安全模式分支）
- Test: `apps/desktop/test/App.largeDoc.test.tsx`（追加用例）

**Interfaces:**
- Consumes: `setBlockRenderBudget`、`SAFE_MODE_RENDER_BUDGET_LINES`（Task 6）。

- [ ] **Step 1: 追加失败测试**：

```tsx
  it("sets a finite block render budget only for safe-mode documents", async () => {
    const harness = createAppHarness(editor)
    harness.services.readFile = vi.fn(async () => bigDoc(50010))
    harness.renderApp()
    await openBigDoc(harness)
    expect(blockRenderBudget()).toBe(SAFE_MODE_RENDER_BUDGET_LINES)
    // 打开普通小文档后恢复
    harness.services.readFile = vi.fn(async () => "small")
    await openDoc(harness)
    expect(blockRenderBudget()).toBe(Infinity)
  })
```

（`blockRenderBudget` 从 `@omd/engine` 导出——Task 6 已提供 `blockRenderBudget()`；若未导出则在 Task 6 的 index 导出列表补上。）

- [ ] **Step 2: 跑测试确认失败** —— Run: `pnpm --filter @omd/desktop exec vitest run test/App.largeDoc.test.tsx`
Expected: FAIL —— 未接线。

- [ ] **Step 3: 实现** —— `resetTabDocument` 中安全模式分支扩展为：

```ts
    const safeMode = lines > SAFE_MODE_LINES
      && safeModeChoiceRef.current.get(nextSession.id) === undefined
    if (safeMode) {
      try { view.dispatch(setLivePreview(false)) } catch { /* mock views */ }
      setBlockRenderBudget(SAFE_MODE_RENDER_BUDGET_LINES)
    } else {
      setBlockRenderBudget(Infinity)
    }
```

（notice 的三元同步改为用 `safeMode` 变量。import 三个符号。）

- [ ] **Step 4: 跑测试确认通过** —— Run: `pnpm --filter @omd/desktop test`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/App.tsx apps/desktop/test/App.largeDoc.test.tsx
git commit -m "feat: apply render budget in safe mode"
```

---

### Task 8: perf-smoke 脚本 + CI advisory 基准 + 文档

**Files:**
- Create: `scripts/perf-smoke.mjs`
- Modify: `package.json`（scripts 增 `perf:smoke`）
- Modify: `.github/workflows/ci.yml`（新增 bench job）
- Modify: `README.md`（性能节）
- Modify: `AGENTS.md`（Commands 增 bench）
- Modify: `packages/engine/AGENTS.md`（bench 命令说明）
- Modify: `docs/memory/known-gotchas.md`（基准抖动条目）
- Modify: `docs/manual-qa.md`（性能节）

**Interfaces:** Consumes Task 3 的 bench 命令与 Task 3 Step 5 留存的控制台数字、`makeBenchmarkDoc`（经脚本内联等价生成器复刻——脚本独立于 workspace 包，避免从 `@omd/engine` 源码路径 import TS）。

- [ ] **Step 1: 写 `scripts/perf-smoke.mjs`**（Spec §4：发布前人工跑。Tauri WebView 无法 headless 自动化，脚本负责确定性的机器可测部分——样本生成与进程 RSS 采样；时延/掉帧归 manual-qa 人感项）：

```js
#!/usr/bin/env node
// 发布前人工性能烟测（Spec 05 §4/§7）：
//   1) 生成 10k/50k 行确定性样本到 /tmp/omd-perf-smoke/
//   2) 提示人工打开样本并操作（打开-可输入、滚动、多标签）
//   3) 循环采样 oh-my-md 进程 RSS，写 perf-smoke-result.json
// 用法：node scripts/perf-smoke.mjs（Ctrl-C 结束采样并落盘）
import { execSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

function makeBenchmarkDoc(lines) {
  const blocks = []
  let produced = 0
  for (let i = 0; produced < lines; i++) {
    const kind = i % 10
    let block
    if (kind === 0) block = `# 标题 ${i}\n\n中文段落 ${i}，包含 **加粗**、[链接](https://example.com/${i}) 与普通文本。`
    else if (kind === 3) block = `| h${i} | v${i} |\n|---|---|\n| 行${i} | 中文单元格 |\n| 行${i + 1} | another cell |`
    else if (kind === 6) block = "```ts\nconst value" + i + " = " + i + ";\nfunction fn" + i + "() { return value" + i + " * 2; }\n```"
    else if (kind === 8) block = "$$\nE_{" + i + "} = mc^2 + " + i + "\n$$"
    else block = `段落 ${i}：中文正文与 English mixed content，用于逐键输入负载。`
    blocks.push(block)
    produced += block.split("\n").length + 1
  }
  return blocks.join("\n\n")
}

const outDir = join(tmpdir(), "omd-perf-smoke")
mkdirSync(outDir, { recursive: true })
for (const n of [10000, 50000]) {
  writeFileSync(join(outDir, `sample-${n}.md`), makeBenchmarkDoc(n))
  console.log(`wrote ${join(outDir, `sample-${n}.md`)}`)
}

console.log("\n人工步骤：")
console.log("  1. 启动应用（pnpm dev 或打包产物）")
console.log("  2. 打开 sample-10000.md，连续输入 10s 记录可感延迟")
console.log("  3. 打开 sample-50000.md（应触发安全模式），滚动 + IME 输入")
console.log("  4. 开满 10 个标签各载入 sample-10000.md，观察前台输入")
console.log("采样进行中（每 2s 记录 RSS），Ctrl-C 结束并写结果。\n")

const samples = []
const timer = setInterval(() => {
  try {
    const out = execSync(
      "ps axo rss,comm | grep -i 'oh-my-md' | grep -v grep | awk '{s+=$1} END {print s+0}'",
      { encoding: "utf8" },
    ).trim()
    const kb = Number(out)
    if (kb > 0) {
      samples.push({ t: Date.now(), rssKb: kb })
      process.stdout.write(`\rrss: ${(kb / 1024).toFixed(1)} MiB (n=${samples.length})`)
    }
  } catch { /* 进程未启动 */ }
}, 2000)

process.on("SIGINT", () => {
  clearInterval(timer)
  const result = {
    date: new Date().toISOString(),
    samples,
    peakRssKb: samples.reduce((max, s) => Math.max(max, s.rssKb), 0),
  }
  const resultPath = join(outDir, "perf-smoke-result.json")
  writeFileSync(resultPath, JSON.stringify(result, null, 2))
  console.log(`\nwrote ${resultPath} (peak RSS ${(result.peakRssKb / 1024).toFixed(1)} MiB)`)
  process.exit(0)
})
```

root `package.json` scripts 增：`"perf:smoke": "node scripts/perf-smoke.mjs"`。

- [ ] **Step 2: ci.yml 新增 job**（`link:` job 之后）：

```yaml
  bench:
    name: Bench (advisory)
    runs-on: ubuntu-latest
    continue-on-error: true
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      # Spec 05: advisory only — runner 抖动大，基准回归不阻断；>50% 回归读日志人工判断。
      - run: pnpm --filter @omd/engine bench
```

- [ ] **Step 3: README 性能节**（「发布」节之前）——粘贴 Task 3 Step 5 的实测输出为表格，形如：

```markdown
## 性能

大文档基准（`pnpm --filter @omd/engine bench`，M-series 开发机，advisory）：

| 指标 | 10k 行 | 50k 行（安全模式） | 预算 |
|---|---|---|---|
| 逐键事务 p95 | <实测> ms | <实测> ms | < 16 ms |
| 冷启动解析 | <实测> ms | <实测> ms | — |
| 装饰重建 | <实测> ms | — | — |
| documentStats | — | <实测> ms | < 8 ms |

> 50k 行以上自动进入安全模式：默认源码模式、按需字数统计、复杂块渲染延迟到接近视口（可手动切回，本次会话内记住）。
```

（`<实测>` 处逐个替换为留存数字；不保留尖括号占位。）

- [ ] **Step 4: AGENTS 文档** —— 根 AGENTS.md Commands 代码块加：

```sh
pnpm --filter @omd/engine bench
```

bullet 加：`- \`pnpm --filter @omd/engine bench\` 跑 advisory 大文档基准（typing p95/冷解析/装饰重建/字数统计）；预算超限只告警不阻断，CI 中 continue-on-error。`

`packages/engine/AGENTS.md` 的命令/验证区追加同一句（按该文件既有列表格式）。

- [ ] **Step 5: known-gotchas 追加**：

```markdown
## Benchmark jitter is real — budgets warn, they never gate

CI runner and local numbers differ by multiples; any machine under load can
double a p95. That is why `bench/typing.bench.ts` logs budget verdicts
(`budgetLine` prints `OK` / `OVER BUDGET (> Nms)` for `TYPING_P95_BUDGET_MS =
16` and `STATS_BUDGET_MS = 8`) instead of using `expect`, and the CI bench job
sets `continue-on-error: true`. Never convert these to hard assertions;
regressions are judged by comparing runs on the same machine (same
`makeBenchmarkDoc` input, which is deterministic by design — do not introduce
randomness into the generator).
```

- [ ] **Step 6: manual-qa 性能节** —— 文末追加：

```markdown
## 性能（Spec 05）

- [ ] 50k 行样本（`makeBenchmarkDoc(50000)` 存盘后打开）：进入安全模式提示条出现、默认源码模式；滚动与 IME 输入手感记录。
- [ ] 安全模式状态栏显示「统计字数」按钮，点击后 1s 内出现实际字数。
- [ ] 安全模式手动切回 Live Preview（⌘E/菜单）：复杂块恢复渲染；同会话再次载入该文档不再强制源码模式。
- [ ] 10 标签 × 10k 行：前台输入无可感卡顿，切换标签 < 500ms（人感）。
- [ ] 发布前跑 `pnpm --filter @omd/engine bench`，数字记入发布说明（README 性能节同步）。
```

- [ ] **Step 7: 全量验证 + Commit**

Run: `pnpm verify`
Expected: engine 288+新增、desktop 全绿、cargo test OK、build OK。

```bash
git add scripts/perf-smoke.mjs package.json .github/workflows/ci.yml README.md AGENTS.md packages/engine/AGENTS.md docs/memory/known-gotchas.md docs/manual-qa.md
git commit -m "docs: perf smoke script, advisory CI bench, and numbers"
```
