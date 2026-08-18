# 05a 超大文档逐键路径 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 Spec 05 §10（05a）：消除 desktop 每键路径上的全部 O(doc) 工作（`doc.toString()`、每键恢复写盘、每键大字符串 setState），修正基准口径并立「生产禁全树解析」不变量。

**Architecture:** 引擎稳态本就达标（部分树 1.5ms/键 @10MB，CM `MaxParseAhead` 钉住后台解析），本计划只动 desktop 应用层：`EditorDocumentUpdate` 去掉 doc 字段（Editor.ts 不再每键展平 rope），App 改拉取式——每键只发轻量版本信号，内容按 250ms trailing 从 `view.state.doc` 物化，消费前经 `getContents`/关键入口同步 flush；恢复写入加 800ms trailing 防抖 + 同内容去重。

**Tech Stack:** React 19、CodeMirror 6（`Text` rope）、Vitest（fake timers）、Tauri IPC。

**Spec:** `docs/superpowers/specs/2026-08-13-05-large-document-performance-design.md` §10

## Global Constraints

- 崩溃恢复丢失窗口 ≤ 物化 250ms + 恢复防抖 800ms ≈ 1.05s（Spec §10.2；关闭标签本就 `forget`）。
- 所有消费 `docsRef` 的持久化/判定路径必须拿到 view 最新内容（`getContents` flush；Spec §10.5）。
- `pendingNormalization` 语义不变：立即传播，不防抖（Spec §10.5）。
- 生产代码（`packages/engine/src/**`、`apps/desktop/src/**`）禁止 `forceParsing`/`ensureSyntaxTree` 推进到 `doc.length`（Spec §10.5 完整树陷阱；Task 3 加护栏测试）。
- 常量具名：`DOC_MATERIALIZE_MS = 250`（App.tsx 常量区，同 `STATS_DEBOUNCE_MS` 先例）、`RECOVERY_DEBOUNCE_MS = 800`（`recoveryWriter.ts` 导出，测试引用）。
- 提交遵循 `<type>: <why>`；不碰无关工作树改动。

---

### Task 1: recoveryWriter 防抖 + 去重 + flush

**Files:**
- Modify: `apps/desktop/src/recoveryWriter.ts`
- Test: `apps/desktop/test/recoveryWriter.test.ts`

**Interfaces:**
- Produces: `createRecoveryWriter(opts?: { debounceMs?: number }): RecoveryWriter`；`RecoveryWriter` 增 `flush: (host: RecoveryHost) => Promise<void>`；`forget(tabId)` 取消该 tab 挂起写；导出 `RECOVERY_DEBOUNCE_MS = 800`。
- Consumes: 既有 `RecoveryDraft`/`RecoveryHost`（不变）。

- [x] **Step 1: 写失败测试** —— `test/recoveryWriter.test.ts` 既有用例外追加（文件若用真实定时器，新用例统一 `vi.useFakeTimers()`）：

```ts
import { createRecoveryWriter, RECOVERY_DEBOUNCE_MS } from "../src/recoveryWriter"

  it("debounces rapid saves into one trailing write", async () => {
    vi.useFakeTimers()
    try {
      const write = vi.fn(async () => undefined)
      const writer = createRecoveryWriter()
      const host = { write, reportError: vi.fn() }
      const draft = { tabId: 1, key: "k", path: "/a.md", contents: "one" }
      writer.save(draft, host)
      writer.save({ ...draft, contents: "two" }, host)
      writer.save({ ...draft, contents: "three" }, host)
      expect(write).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(RECOVERY_DEBOUNCE_MS)
      expect(write).toHaveBeenCalledTimes(1)
      expect(write).toHaveBeenCalledWith("k", "three")
    } finally {
      vi.useRealTimers()
    }
  })

  it("skips the write when contents are unchanged since the last write", async () => {
    vi.useFakeTimers()
    try {
      const write = vi.fn(async () => undefined)
      const writer = createRecoveryWriter()
      const host = { write, reportError: vi.fn() }
      const draft = { tabId: 1, key: "k", path: "/a.md", contents: "same" }
      writer.save(draft, host)
      await vi.advanceTimersByTimeAsync(RECOVERY_DEBOUNCE_MS)
      expect(write).toHaveBeenCalledTimes(1)
      writer.save(draft, host)                       // 250ms 后物化重发同内容
      await vi.advanceTimersByTimeAsync(RECOVERY_DEBOUNCE_MS)
      expect(write).toHaveBeenCalledTimes(1)          // 去重：不再写
    } finally {
      vi.useRealTimers()
    }
  })

  it("flush forces pending writes immediately and forget cancels them", async () => {
    vi.useFakeTimers()
    try {
      const write = vi.fn(async () => undefined)
      const writer = createRecoveryWriter()
      const host = { write, reportError: vi.fn() }
      writer.save({ tabId: 1, key: "k1", path: "/a.md", contents: "x" }, host)
      await writer.flush(host)
      expect(write).toHaveBeenCalledWith("k1", "x")
      writer.save({ tabId: 2, key: "k2", path: "/b.md", contents: "y" }, host)
      writer.forget(2)
      await vi.advanceTimersByTimeAsync(RECOVERY_DEBOUNCE_MS)
      expect(write).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
```

（`host` 形状按既有 `RecoveryHost` 字段名对齐：若既有测试的 host 是 `{ write, reportError }` 之外还有字段，照抄既有构造。）

- [x] **Step 2: 跑测试确认失败** —— Run: `pnpm --filter @omd/desktop exec vitest run test/recoveryWriter.test.ts`
Expected: FAIL —— `RECOVERY_DEBOUNCE_MS` 未导出 / `flush` 不存在。

- [x] **Step 3: 实现** —— `recoveryWriter.ts` 重写（保留既有 `surfaceFailure` 与错误上报语义）：

```ts
export const RECOVERY_DEBOUNCE_MS = 800

interface PendingWrite {
  draft: RecoveryDraft
  host: RecoveryHost
  timer: number
}

export function createRecoveryWriter(): RecoveryWriter {
  const reported = new Set<number>()
  const lastWritten = new Map<number, string>()
  const pending = new Map<number, PendingWrite>()

  const writeNow = async (entry: PendingWrite) => {
    pending.delete(entry.draft.tabId)
    try {
      await entry.host.write?.(entry.draft.key, entry.draft.contents)
      lastWritten.set(entry.draft.tabId, entry.draft.contents)
      reported.delete(entry.draft.tabId)
    } catch (error) {
      surfaceFailure(reported, entry.draft, entry.host, error)
    }
  }

  return {
    save: (draft, host) => {
      if (lastWritten.get(draft.tabId) === draft.contents) return Promise.resolve()
      const existing = pending.get(draft.tabId)
      if (existing) window.clearTimeout(existing.timer)
      const timer = window.setTimeout(() => { void writeNow({ draft, host, timer }) }, RECOVERY_DEBOUNCE_MS)
      pending.set(draft.tabId, { draft, host, timer })
      return Promise.resolve()
    },
    flush: async host => {
      for (const entry of [...pending.values()]) {
        if (entry.host.write !== host.write) continue
        window.clearTimeout(entry.timer)
        await writeNow(entry)
      }
    },
    forget: tabId => {
      const entry = pending.get(tabId)
      if (entry) window.clearTimeout(entry.timer)
      pending.delete(tabId)
      lastWritten.delete(tabId)
      reported.delete(tabId)
    },
  }
}
```

`RecoveryWriter` 接口类型增 `flush`。注意：`save` 原签名返回 Promise（App 侧 `void ...save(...)`），保持。

- [x] **Step 4: 适配既有 4 个用例** —— 既有测试若断言「save 后立即 write」，改为 `await vi.advanceTimersByTimeAsync(RECOVERY_DEBOUNCE_MS)` 后断言。跑全套确认通过：
Run: `pnpm --filter @omd/desktop exec vitest run test/recoveryWriter.test.ts`
Expected: PASS。

- [x] **Step 5: App 侧既有恢复断言适配** —— Run: `pnpm --filter @omd/desktop test`
如有 App 级用例断言 emit 后 `writeRecovery` 立即被调（grep `writeRecovery` in test/*.tsx），改为 fake timers 推进或 `waitFor`。预期少量改动。
Expected: 全套 PASS。

- [x] **Step 6: Commit**

```bash
git add apps/desktop/src/recoveryWriter.ts apps/desktop/test/recoveryWriter.test.ts
git commit -m "perf: debounce recovery writes and dedupe unchanged content"
```

---

### Task 2: EditorDocumentUpdate 去 doc + App 拉取式物化

**Files:**
- Modify: `apps/desktop/src/Editor.ts`（`:28-34` 接口、`:125-136` reportEditorUpdate）
- Modify: `apps/desktop/src/App.tsx`（`:499-519` saveRecovery/handleDocumentUpdate、`:236-243` 常量区与 refs、`:380/:390` 两处 `getContents`、`:963-970` runOpen、`:1132` requestCloseTab、`:578-592` resetTabDocument）
- Modify: `apps/desktop/test/appHarness.ts`（`:125-134` notifyHost、`:153-162` emit）
- Test: `apps/desktop/test/App.docMaterialize.test.tsx`（新建）

**Interfaces:**
- Produces:
  - `EditorDocumentUpdate { tabId, documentId, docChanged, pendingNormalization }`（无 `doc`）。
  - App 内部：`DOC_MATERIALIZE_MS = 250`；`pendingDocTabsRef: useRef(Set<number>)`；`materializePendingDocs(): void`；`flushPendingDocs(): void`（清定时器 + 立即物化）。
- Consumes: Task 1 的防抖 writer（物化节奏调 `saveRecovery`）。

- [x] **Step 1: 写失败测试** `test/App.docMaterialize.test.tsx`（harness 头部 mock 块同 `App.stats.test.tsx`）：

```tsx
import { act, fireEvent, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { EditorView } from "@codemirror/view"
import type { CreateEditorOptions } from "../src/Editor"
import { createAppHarness, resetMountedApps } from "./appHarness"

vi.mock("@omd/engine", async importOriginal => {
  const actual = await importOriginal<typeof import("@omd/engine")>()
  return {
    ...actual,
    exportHtml: () => "<!doctype html><html>exported</html>",
    exportRichHtml: async () => "<!doctype html><html>exported</html>",
    collectOutline: () => [],
    getPendingOrderedListNormalization: vi.fn(() => null),
  }
})

const { editor } = vi.hoisted(() => ({
  editor: { create: vi.fn(), reset: vi.fn() },
}))

vi.mock("../src/Editor", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/Editor")>()
  return {
    ...actual,
    createEditor: (parent: HTMLElement, options: CreateEditorOptions) =>
      editor.create(parent, options),
    resetEditorDocument: (view: EditorView, options: CreateEditorOptions) =>
      editor.reset(view, options),
  }
})

afterEach(() => resetMountedApps())

describe("deferred doc materialization", () => {
  it("coalesces rapid keystrokes into one recovery write after the debounce", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const harness = createAppHarness(editor)
      await harness.openFileTab("/a.md", "hello")
      harness.services.writeRecovery = vi.fn(async () => undefined)
      const handle = harness.editorForTab(1)
      for (const text of ["a", "b", "c"]) {
        handle.emit({ doc: text, docChanged: true, pendingNormalization: null })
      }
      // 物化 250ms + 恢复防抖 800ms 内：零写盘
      expect(harness.services.writeRecovery).not.toHaveBeenCalled()
      await act(async () => { await vi.advanceTimersByTimeAsync(1100) })
      expect(harness.services.writeRecovery).toHaveBeenCalledTimes(1)
      expect(harness.services.writeRecovery).toHaveBeenCalledWith(
        expect.anything(), expect.stringContaining("c"),
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it("saves the newest content when saving inside the debounce window", async () => {
    const harness = createAppHarness(editor)
    await harness.openFileTab("/a.md", "hello")
    const handle = harness.editorForTab(1)
    handle.emit({ doc: "world", docChanged: true, pendingNormalization: null })
    // 防抖窗口内直接 ⌘S：flush 必须让落盘内容为最新
    await harness.saveActive()
    expect(harness.disk("/a.md").contents()).toBe("world")
  })
})
```

（`DiskFixture.contents` 是函数：`disk(path).contents(): string | null`，见 `fakeDisk.ts:18`；`saveActive` 已存在于 harness。）

- [x] **Step 2: 跑测试确认失败** —— Run: `pnpm --filter @omd/desktop exec vitest run test/App.docMaterialize.test.tsx`
Expected: FAIL —— 第二个用例落盘 `"hello"`（当前 `syncDoc` 在 emit 时同步执行则不会失败——若因同步执行而通过，改为断言 `writeRecovery` 计数的第一个用例已 FAIL，仍满足 TDD 门）。

- [x] **Step 3: Editor.ts 去掉每键 toString** —— 接口删除 `doc` 字段；`reportEditorUpdate` 改为：

```ts
function reportEditorUpdate(options: CreateEditorOptions, update: ViewUpdate): void {
  const pending = getPendingOrderedListNormalization(update.state)
  const before = getPendingOrderedListNormalization(update.startState)
  if (!update.docChanged && samePending(before, pending)) return
  options.onDocumentUpdate({
    tabId: options.tabId,
    documentId: options.documentId,
    docChanged: update.docChanged,
    pendingNormalization: pending,
  })
}
```

- [x] **Step 4: App 拉取式物化** —— 常量区（`STATS_DEBOUNCE_MS` 旁）：

```ts
// Spec 05a：每键不物化整文档字符串；250ms trailing 从 view 拉取（消费前 flush）。
const DOC_MATERIALIZE_MS = 250
```

refs（`safeModeChoiceRef` 旁）：

```ts
  const pendingDocTabsRef = useRef(new Set<number>())
  const docMaterializeTimerRef = useRef<number | null>(null)
  const [, setDocVersion] = useState(0)
```

`handleDocumentUpdate`（`:507`）整体替换：

```ts
  function materializePendingDocs() {
    if (docMaterializeTimerRef.current !== null) {
      window.clearTimeout(docMaterializeTimerRef.current)
      docMaterializeTimerRef.current = null
    }
    for (const tabId of [...pendingDocTabsRef.current]) {
      pendingDocTabsRef.current.delete(tabId)
      const view = viewsRef.current.get(tabId)
      if (!view) continue
      const contents = view.state.doc.toString()
      syncDoc(contents, tabId)
      const tab = workspaceRef.current.tabs.find(t => t.id === tabId)
      if (tab) saveRecovery(tab, contents)
    }
  }

  function flushPendingDocs() {
    materializePendingDocs()
  }

  function handleDocumentUpdate(update: EditorDocumentUpdate) {
    const tab = tabById(update.tabId)
    if (!tab || tab.documentId !== update.documentId) return
    if (update.docChanged) {
      pendingDocTabsRef.current.add(update.tabId)
      if (docMaterializeTimerRef.current === null) {
        docMaterializeTimerRef.current = window.setTimeout(
          () => materializePendingDocs(), DOC_MATERIALIZE_MS,
        )
      }
      setDocVersion(v => v + 1)
    }
    commitNormalization(projectNormalizationNotice(
      normalizationRef.current,
      update.tabId,
      update.pendingNormalization,
    ))
  }
```

（`saveRecovery` 定义保持在 `handleDocumentUpdate` 之上；unmount 清理：既有 unmount effect 里加 `if (docMaterializeTimerRef.current !== null) window.clearTimeout(...)`。）

flush 接线（四处）：

1. save 桥 `getContents`（`:390`，`createDocumentSaveAppBridge`）：

```ts
    getContents: tabId => {
      if (pendingDocTabsRef.current.has(tabId)) materializePendingDocs()
      return docsRef.current.get(tabId) ?? ""
    },
```

2. conflictSave `getContents`（`:380`）同样改法。
3. `runOpen`（`:963`）开头加 `flushPendingDocs()`（dirty 判定读 `docRef.current`）。
4. `requestCloseTab`（`:1132`）开头加 `flushPendingDocs()`。

`resetTabDocument`（`:578` 附近）在 `setStatsRequested(0)` 行旁加 `pendingDocTabsRef.current.delete(nextSession.id)`（重载内容即最新，物化反而会拿旧 view 覆盖时序）。

- [x] **Step 5: harness 适配** —— `notifyHost` 不再透传 doc：

```ts
function notifyHost(
  options: CreateEditorOptions,
  update: Omit<EditorDocumentUpdate, "tabId" | "documentId">,
): void {
  options.onDocumentUpdate({
    ...update,
    tabId: options.tabId,
    documentId: options.documentId,
  })
}
```

`emit`（`:160`）改为 `doc` 只进本地 bookkeeping：

```ts
    emit: update => {
      contents = update.doc
      pending = update.pendingNormalization
      act(() => notifyHost(options, {
        docChanged: update.docChanged,
        pendingNormalization: update.pendingNormalization,
      }))
    },
```

`FakeEditorHandle.emit` 参数类型保持含 `doc`（测试调用形状不变）。

- [x] **Step 6: 既有测试适配 + 全套跑绿** —— Run: `pnpm --filter @omd/desktop exec tsc -p tsconfig.test.json`
修掉所有「onDocumentUpdate 载携带 doc」的直接构造（grep `onDocumentUpdate({`）。再跑：
Run: `pnpm --filter @omd/desktop test`
适配模式：
- 断言 emit 后立即 `writeRecovery`/落盘恢复 → `advanceTimersByTimeAsync(1100)` 或走 `saveActive()`（flush 路径）。
- 断言 statusbar/dirty 在 emit 后即时出现 → `advanceTimersByTimeAsync(300)`（物化窗口）。
- 直接调 `opts.onDocumentUpdate({..., doc: "..."})` 的测试（如 `App.stats.test.tsx`）→ 删 `doc` 字段（fake view 的 `state.doc.toString()` 会返回 harness 记录的最新内容，防抖推进后断言不变）。
Expected: 全套 PASS（344+ 用例）。

- [x] **Step 7: Commit**

```bash
git add apps/desktop/src/Editor.ts apps/desktop/src/App.tsx apps/desktop/test/appHarness.ts apps/desktop/test/App.docMaterialize.test.tsx
git commit -m "perf: pull doc content on materialize cadence instead of per keystroke"
```

（若既有测试适配涉及更多文件，一并 `git add`。）

---

### Task 3: 基准口径修正 + 全树护栏 + 文档

**Files:**
- Modify: `packages/engine/bench/generate.ts`（增 `makeBenchmarkDocBytes`）
- Modify: `packages/engine/bench/measure.ts`（`measureTyping` 增 `tree` 口径）
- Modify: `packages/engine/bench/typing.bench.ts`（用例重排）
- Test: `apps/desktop/test/crossLayerNoFullTree.test.ts`（新建）
- Modify: `README.md`（性能表）
- Modify: `docs/memory/known-gotchas.md`（完整树陷阱条目）
- Modify: `packages/engine/AGENTS.md`（不变量）

**Interfaces:**
- Produces: `makeBenchmarkDocBytes(targetUtf8Bytes: number): string`；`measureTyping(doc, opts?: { keystrokes?: number; mode?: "live" | "source"; tree?: "steady" | "complete" })`（默认 `{ mode: "live", tree: "steady" }`）。

- [x] **Step 1: 写失败护栏测试** `test/crossLayerNoFullTree.test.ts`：

```ts
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...tsFiles(full))
    else if (/\.(ts|tsx)$/.test(name)) out.push(full)
  }
  return out
}

describe("no full-tree parse in production code", () => {
  it("engine and desktop src never call forceParsing/ensureSyntaxTree", () => {
    const roots = ["../src", "../../../packages/engine/src"]
    const offenders: string[] = []
    for (const root of roots) {
      for (const file of tsFiles(join(import.meta.dirname, root))) {
        const text = readFileSync(file, "utf8")
        if (/forceParsing\s*\(|ensureSyntaxTree\s*\(/.test(text)) offenders.push(file)
      }
    }
    expect(offenders).toEqual([])
  })
})
```

Run: `pnpm --filter @omd/desktop exec vitest run test/crossLayerNoFullTree.test.ts` — 预期直接 PASS（护栏性质，先落位）。

- [x] **Step 2: 基准口径** —— `generate.ts` 追加（UTF-8 字节精确版，内容与 `makeBenchmarkDoc` 同构）：

```ts
function utf8Bytes(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) n += s.charCodeAt(i) < 128 ? 1 : 3
  return n
}

/** Spec 05a：10/20MB 档按 UTF-8 字节生成（中英混合负载）。 */
export function makeBenchmarkDocBytes(targetBytes: number): string {
  const blocks: string[] = []
  let produced = 0
  for (let i = 0; produced < targetBytes; i++) {
    const kind = i % 10
    let block: string
    if (kind === 0) block = `# 标题 ${i}\n\n中文段落 ${i}，包含 **加粗**、[链接](https://example.com/${i}) 与普通文本。`
    else if (kind === 3) block = `| h${i} | v${i} |\n|---|---|\n| 行${i} | 中文单元格 |\n| 行${i + 1} | another cell |`
    else if (kind === 6) block = "```ts\nconst value" + i + " = " + i + ";\nfunction fn" + i + "() { return value" + i + " * 2; }\n```"
    else if (kind === 8) block = "$$\nE_{" + i + "} = mc^2 + " + i + "\n$$"
    else block = `段落 ${i}：中文正文与 English mixed content，用于逐键输入负载。`
    blocks.push(block)
    produced += utf8Bytes(block) + 2
  }
  return blocks.join("\n\n")
}
```

`measure.ts::measureTyping` 的 opts 增 `tree?: "steady" | "complete"`（默认 `"steady"`）：

```ts
export function measureTyping(
  doc: string,
  opts: { keystrokes?: number; mode?: "live" | "source"; tree?: "steady" | "complete" } = {},
): TypingLatency {
  const count = opts.keystrokes ?? 200
  const mode = opts.mode ?? "live"
  const tree = opts.tree ?? "steady"
  let state = baseState(doc)
  if (mode === "source") state = state.update(setLivePreview(false)).state
  const parent = document.createElement("div")
  document.body.appendChild(parent)
  const view = new EditorView({ state, parent })
  // steady：镜像生产稳态 —— CM idle worker 只解析到 viewport.to + 100000（MaxParseAhead）。
  // complete：全树（worst-case 上限参考；完整树后每键 fragment 重启随文档规模增长）。
  forceParsing(view, tree === "complete" ? doc.length : view.viewport.to + 100000, 60000)
  // ……其余不变
```

（现签名 `opts = { mode: "live" }` 全量默认，改为如上解构默认。）

`typing.bench.ts` 用例调整：10k/50k 现有用例显式 `tree: "steady"`（主口径）；追加：

```ts
  bench("typing 10k lines (live, complete tree — worst case)", () => {
    const r = measureTyping(DOC_10K, { mode: "live", tree: "complete", keystrokes: 50 })
    console.info(`[worst-case] typing p95 10k live complete-tree: ${r.p95Ms.toFixed(2)}ms`)
  })

  bench("typing 10MB (source, steady)", () => {
    const r = measureTyping(DOC_10MB, { mode: "source", tree: "steady", keystrokes: 60 })
    console.info(budgetLine("typing p95 10MB source steady", r.p95Ms, TYPING_P95_BUDGET_MS))
  })

  bench("typing 20MB (source, steady)", () => {
    const r = measureTyping(DOC_20MB, { mode: "source", tree: "steady", keystrokes: 40 })
    console.info(budgetLine("typing p95 20MB source steady", r.p95Ms, TYPING_P95_BUDGET_MS))
  })
```

`const DOC_10MB = makeBenchmarkDocBytes(10 * 1024 * 1024)`、`DOC_20MB = makeBenchmarkDocBytes(20 * 1024 * 1024)`。

- [x] **Step 3: 跑基准确认口径数字** —— Run: `pnpm --filter @omd/engine bench`
Expected: steady 档 10k/50k/10MB/20MB 全部 `OK`（10MB/20MB 预期 <16ms，诊断实测 1.5-3ms 量级）；complete worst-case 仅记录数字。留存输出供 README。

- [x] **Step 4: README + gotchas + engine AGENTS** —— README 性能表追加两行：

```markdown
| 逐键事务 p95（10MB/20MB，源码稳态） | 10MB: <实测> ms | 20MB: <实测> ms | < 16 ms |
```

并在表下注释补一句：`完整树（如外部工具强制全解析）是 worst case，见 known-gotchas「complete-tree trap」。`

known-gotchas 追加：

```markdown
## The complete-tree trap: never force a full parse in production

Steady-state CM only parses up to `viewport.to + 100000` (`Work.MaxParseAhead` in
@codemirror/language's idle worker); partial-tree typing is O(edit) — 1.5ms p95 at
10MB/380k lines. If any production path forces the tree to `doc.length`
(`forceParsing`/`ensureSyntaxTree`), every subsequent keystroke restarts fragment
matching over the whole tree: measured 23.5ms at 1MB and 70.6ms at 10MB per
keystroke. `test/crossLayerNoFullTree.test.ts` guards this by scanning
`packages/engine/src` and `apps/desktop/src` for those calls; test helpers may
force full parses (they own small docs). Also mind the giant-paragraph cliff:
one Lezer `advance()` parses an entire leaf block, so a multi-MB single
paragraph costs seconds per keystroke.
```

`packages/engine/AGENTS.md` Testing 区追加一行：

```sh
- Production code must never advance parsing to `doc.length` (`forceParsing`/`ensureSyntaxTree`) — see the complete-tree trap in `docs/memory/known-gotchas.md`; `apps/desktop/test/crossLayerNoFullTree.test.ts` guards it.
```

- [x] **Step 5: 全量验证 + Commit**

Run: `pnpm --filter @omd/desktop exec vitest run test/crossLayerNoFullTree.test.ts && pnpm test`
Expected: PASS。

```bash
git add packages/engine/bench/generate.ts packages/engine/bench/measure.ts packages/engine/bench/typing.bench.ts apps/desktop/test/crossLayerNoFullTree.test.ts README.md docs/memory/known-gotchas.md packages/engine/AGENTS.md
git commit -m "test: steady-state bench caliber and full-tree guard"
```

---

### Task 4: 收尾验证与文档同步

**Files:**
- Modify: `docs/manual-qa.md`（性能节补两行）
- Modify: `docs/superpowers/plans/2026-08-19-05a-huge-doc-typing.md`（勾选）

- [x] **Step 1: manual-qa 性能节追加**：

```markdown
- [x] 10MB/20MB 样本（`makeBenchmarkDocBytes` 存盘后打开）：逐键无可感卡顿（p95 < 16ms，安全模式源码）；连续输入 10s 后暂停，确认崩溃恢复文件包含末次内容（≤1s 窗口）。
- [x] 防抖窗口内 ⌘S / 关闭标签 / 另存：落盘与 dirty 判定均基于最新输入（flush 生效）。
```

- [x] **Step 2: 全量验证** —— Run: `pnpm verify`
Expected: engine 292+、desktop 全绿（含新增 3+2+1 用例）、cargo test OK、build OK。

- [x] **Step 3: Commit + 勾选计划**

```bash
git add docs/manual-qa.md docs/superpowers/plans/2026-08-19-05a-huge-doc-typing.md
git commit -m "docs: sync 05a manual qa and plan completion"
```
