# 大文件 Live 渐进渲染 + 快速文件切换

日期：2026-08-20 · 分支：`perf/large-file-live-render` · 状态：执行中（SDD）

## Context

用户报告两个大文件（~50MB Markdown）体验问题：

1. **Ctrl+E 无法进入 Live 模式**。根因有二：
   - 切 Live 是 compartment 重配置，`packages/engine/src/decorations/build.ts:175` 的 `tr.reconfigured` 分支对 `0..doc.length` 做一次性同步全量装饰构建，50MB 主线程阻塞数秒、无绘制无超时；叠加 `packages/engine/src/lists/ordered.ts` 的 `orderedRenumber` 入场微任务全树扫描（`ordered.ts:324-360`）。
   - ≥50MiB 档按 05b 规格以 `plainText: true` 打开（不挂解析器，`packages/engine/src/index.ts:95`），Ctrl+E 重配置后空树零装饰，是设计内空操作。
   - 引擎已有增量装饰机制（脏区重建、树增长跟进、widget 渲染预算），唯 toggle/create 两条路径绕过它走全量。
2. **文件切换 ≥1s（大小互切）**。激活路径上的 O(doc) 工作：
   - 每次激活无条件 `refreshChrome` → `collectOutline` 全语法树遍历（`apps/desktop/src/App.tsx:1380`、`packages/engine/src/outline.ts:29`）。
   - 保存成功后 `host.syncDoc(view.state.doc.toString(), tabId)`（`apps/desktop/src/documentSaveRunner.ts:268`）重新拍平，破坏引用相等，之后每次渲染 `dirtyIds` 的 `doc !== savedContents`（`App.tsx:2059`）退化为 O(n) 比较。
   - 后台 `pollFileTabs` 每 30s + 每个 watcher 事件对每个已加载 tab 全量读盘 + blake3（Rust `probe_disk_raw`）。
   - find 打开时 `collectMatches` 全文正则（`App.tsx:2090`）。
   - 惰性恢复 tab 首次激活走完整打开管线（流式读 + join + `Text.of` 全文 split，bench 预算 8s）。

## 已确认决策（用户拍板）

1. ≥50MiB 只读档：**允许只读 Live 预览**（挂 Markdown 解析器 + 渐进渲染，保持只读）。内存权衡（解析树随滚动累积 ~2-4× 文件大小）已接受，横幅明示。
2. 10–50MiB 大文件：**打开即默认 Live 渐进渲染**（不再强制源码模式）。

## Global Constraints（每个任务的派发词都必须携带）

- **正常文档（非 over-scale）行为不变是硬约束**：渐进构建到全量后，装饰语义与今天逐位一致；现有测试除 `makeState` 排空步骤外不应大面积变动。
- 生产代码禁止 `forceParsing`/`ensureSyntaxTree` 全树强制（`apps/desktop/test/crossLayerNoFullTree.test.ts` 守卫；新测试助手不得违反）。
- IPC 契约变更必须三处同步：Rust 命令、`apps/desktop/src/desktopServices.ts`、所有 TS 消费方；多字字段需 Rust 序列化 JSON 断言测试（工作区规则 7/8）。
- 引擎不得 import React/Tauri；跨层值放 `apps/desktop/src/constants.ts` / `packages/engine/src/parse/chars.ts` 并加漂移测试。本计划新增常量均为引擎内部或桌面内部，无新跨层值。
- 提交遵守 commit-msg 钩子：`<type>: <why>`（feat/fix/refactor/docs/test/chore/perf/ci），无 `Co-authored-by`。
- 基线提交：`1b62526`。测试入口：`pnpm test`（engine tsc+vitest）、`pnpm --filter @omd/desktop test`、`cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`。
- 主 checkout 有未提交的 tightSelection 等无关变更，worktree 自 HEAD 新建，不得回写主 checkout。

---

## Task 1: 引擎 — 渐进装饰构建核心（pending 模型 + 种子构建）

改造 `packages/engine/src/decorations/build.ts`：

1. `LiveDeco` 接口增加 `pending: {from,to}[]`（未构建区间，有序、互不相交）。
2. `buildLiveDecorations(state)` 不再构建 `0..doc.length`。新函数 `seedLiveDecorations(state)`：以**主选择区 head 所在行为中心**，构建 `[max(0, seedFrom), min(doc.length, seedTo)]`：
   - `seedFrom` = 光标行号 − `LIVE_SEED_RADIUS_LINES`(=300) 行的行首；`seedTo` = 光标行号 + 300 行的行尾；再按字符半径 `LIVE_SEED_RADIUS_CHARS`(=120_000) 双向截断。常量定义在 build.ts 顶部并导出。
   - 返回值：种子区间的 deco/atomic/specs（复用 `collectDecorationSpecs` + `decorationSets`）+ `pending` = `[0,doc.length]` 减去种子区间（0 或 1 或 2 段）+ `treeLength = syntaxTree(state).length`。
3. `livePreviewField.create` 与 `updateLiveDecorations` 的 `tr.reconfigured` 分支改用 `seedLiveDecorations`（两者从此都不再全量）。
4. 新增 `export const liveBuildChunk = StateEffect.define<{from:number,to:number}>()`。`updateLiveDecorations` 处理携带该 effect 的交易：把 `[from,to]` 并入本交易的重建范围（与 docChanged/选择区/树增长的 rebuildRanges 合并后走现有 map+filter+add 路径），并从 `pending` 中移除已覆盖部分（区间减法，保持有序不相交）。
5. `docChanged` 交易：`pending` 各区间经 `tr.changes.mapPos(from,-1)/mapPos(to,1)` 映射（塌缩区间丢弃）；编辑脏区仍按现有逻辑同步立即重建（行为不变）。
6. 树增长分支（现 build.ts:166-170）：当 `pending` 非空时，树增长区间**并入 pending 而不是同步构建**（避免与分片驱动重复）；`pending` 为空时保持现状（同步跟进）。
7. 测试排空助手：从 build.ts 导出 `drainPendingLiveBuild(view: EditorView)`（仅供测试）：循环对 pending 各区间按 ≤262_144 字符分片 dispatch `liveBuildChunk`，直到 pending 为空。不使用 forceParsing/ensureSyntaxTree。
8. `packages/engine/test/helpers.ts` 的 `makeState`：在现有 forceParsing 之后，对含 livePreviewField 的 state 执行同步排空（实现方式：makeState 已挂临时 view，先 dispatch 排空再返回 view.state；对不含 live 扩展的用例零影响）。
9. `apps/desktop/test/crossLayerNoFullTree.test.ts`：把 `drainPendingLiveBuild` 纳入禁用扫描豁免清单（若脚本按名字扫描则确认它不含禁用调用即可，无需改动扫描器）。

测试（`packages/engine/test/`，新增 progressive.test.ts 或并入 incremental.test.ts）：
- 种子构建：长文档 create 后，光标 ±种子半径内有装饰，远端无装饰且 pending 覆盖远端。
- chunk 消耗：dispatch `liveBuildChunk` 后区间内装饰出现、pending 缩减、与既有装饰合并无重复（沿用 `changedSpecCount` 类断言风格）。
- docChanged 映射：pending 区间随插入/删除正确移动。
- `makeState` 排空后全文档装饰与旧实现快照一致（用现有 fixtures 如 `large.md` 对拍：排空后的 deco 数量/位置与全量构建结果相同）。
- 树增长并入 pending 的行为（pending 非空时增长区间不立即产出装饰）。

验证：`pnpm test`（含 tsc --noEmit）。

## Task 2: 引擎 — 分片驱动 ViewPlugin（idle 切片 + 视口优先）

`packages/engine/src/modes/livePreview.ts`：

1. `livePreviewExt()` 增加 `liveBuildDriver`（新 ViewPlugin，实现可放新文件 `packages/engine/src/decorations/buildDriver.ts`）：
   - 构造与每次 update（docChanged/selectionSet/viewportChanged）后：若 `state.field(livePreviewField).pending` 非空且未在调度中，先 `queueMicrotask` 同步构建当前 `view.visibleRanges`（每段截断到 ≤262_144 字符，dispatch `liveBuildChunk`），保证切换后首帧可见区有装饰。
   - 然后启动空闲分片循环：`requestIdleCallback`（不存在则 `setTimeout`，happy-dom 兼容）每次回调取「距视口最近的 pending 区间」（按区间端点到 `view.visibleRanges` 的最小距离排序），从靠近视口一端切 ≤262_144 字符一片 dispatch `liveBuildChunk`；每片之间让出（重新调度）。同一 idle 回调内最多工作 `LIVE_BUILD_SLICE_MS`(=24)ms（`performance.now()` 计时，不存在时按 1 片/回调）。
   - `destroy()` 停止循环；pending 清空后自动停。
   - 禁止在 update 回调内直接 dispatch（CM 限制）——所有 dispatch 都经 microtask/idle 回调。
2. 视口变化重排优先级（无需取消在途回调，每次回调重新选最近区间即可）。
3. 单测（可用 `Object.defineProperty(view, "visibleRanges")` 或真实滚动布局之外的直接构造）：
   - pending 非空时微任务构建了 visibleRanges；
   - 分片循环按距离优先（近的区间先耗尽）；
   - view.destroy 后不再 dispatch；
   - fake timers 驱动 setTimeout 回退路径。
4. 保持既有测试全绿（`makeState` 排空路径不经驱动插件，无 flake）。

验证：`pnpm test`。

## Task 3: 引擎 — over-scale 窗口化装饰（裁剪/重建）

前提：Task 1/2 已合入。目标：安全模式（over-scale）下装饰内存与映射成本有界。

1. 新文件 `packages/engine/src/safeModeRendering.ts`：仿 `renderBudget.ts` 的模块级全局——`setSafeModeRendering(on: boolean)`、`safeModeRenderingEnabled()`，默认 false。经 `packages/engine/src/index.ts` 导出（与 `setBlockRenderBudget` 同组）。
2. 窗口化（在 build.ts 的驱动插件或 chunk 处理中实现，选实现上最自然的位置）：当 `safeModeRenderingEnabled()` 为 true：
   - 种子/分片构建照常，但**不再耗尽到全量**：pending 保留（驱动循环只构建「视口 ± `LIVE_WINDOW_CHARS`(=262_144) 字符」内的 pending 部分；窗口外的 pending 保留待滚动）。
   - 每次排空/滚动后**裁剪**：specs/deco/atomic 中位于窗口外的装饰移除（等再次进入窗口时经 pending 重建）。裁剪在分片 dispatch 的同一交易里做（新增 effect 或复用 chunk 处理：携带窗口信息，超窗装饰 filter 掉、其区间归还 pending）。
   - 编辑映射仍走现有增量路径（窗口内编辑正常）；窗口外编辑（罕见，如全部替换）由 docChanged 的 pending 映射兜住。
3. `packages/engine/test`：窗口裁剪、滚入重建（可见区间变化后重新构建）、往返滚动不重复累积（specs 数量有界）、窗口内编辑映射不变。
4. `apps/desktop/src/App.tsx` 的 `applyRenderBudgetFor`（App.tsx:613-618）同步调用 `setSafeModeRendering(...)`（与 `setBlockRenderBudget` 同参语义：safe-mode tab → true，否则 false）。此项也可由 Task 6 一并接线，但必须在本任务内完成以保持桌面可编译可测（桌面测试若断言预算行为需同步更新）。

验证：`pnpm test` + `pnpm --filter @omd/desktop test`。

## Task 4: 引擎 — orderedRenumber 范围限制

1. `packages/engine/src/lists/ordered.ts`：`orderedRenumberChanges(state, range?: {from,to})`——有 range 时 `syntaxTree(state).iterate({from,to,...})`（enter 回调拿到的 `node.node` 是完整 OrderedList 节点，`forEachOrderedMark` 编号语义不变——跨 range 边界的列表也能正确重编，因 iterate 对与 range 相交的节点都会 enter）。
2. `orderedRenumber` ViewPlugin：当 `safeModeRenderingEnabled()`（Task 3 的全局）：
   - 构造函数入场扫描与树增长触发的扫描限制在 `view.visibleRanges` 各段 ± `RENUMBER_SCAN_MARGIN_CHARS`(=100_000)（常量放 ordered.ts 并导出）。
   - `docChanged` 触发的扫描限制在变更范围外扩到所属列表（用 `tr.changes.iterChangedRanges`，每段用 `expandRange` 风格外扩或直接 ±margin，实现取简单正确者）。
   - 非安全模式行为不变（全树扫描）。
3. 测试：安全模式下远端乱序列表不触发入场重编号（无 notice），视口内乱序列表触发；docChanged 局部重编号正确；非安全模式回归不变。

验证：`pnpm test`。

## Task 5: 引擎 — bench 新场景 + perf-smoke + README

`packages/engine/bench/`：

1. `measure.ts` 新增 `measureLiveToggleMs(doc, lines?)`：构造 source 模式 state（`defaultLivePreview:false`），dispatch `setLivePreview(true)`，计时到交易返回（= 种子构建 + reconfigure），并单独测 `seedLiveDecorations` 纯函数耗时。
2. `toggle.bench.ts`（新或并入 typing.bench.ts）：10MB/20MB `makeBenchmarkDocBytes` 场景，advisory 预算 `TOGGLE_SEED_BUDGET_MS = 100`（仅告警不阻断，遵循现有 budgetLine 模式）。
3. `open.bench.ts` 增加 open-**live** 摄入场景（`defaultLivePreview: true` + makeState 风格挂载后首帧），与现有 source 摄入并列输出。
4. `typing.bench.ts` 增加安全模式窗口化稳态 typing 场景（10MB，safeModeRendering on，测 p95）。
5. `scripts/perf-smoke.mjs` 增加对应冒烟项（内联生成器保持确定性，不引入随机）。
6. README 性能表更新新场景数字（advisory）。

验证：`pnpm --filter @omd/engine bench` 跑通（数字仅记录）。

## Task 6: 桌面 — 大文件默认 Live + 只读档渲染（问题 1 交付）

前提：Task 1-4 已合入。

1. `apps/desktop/src/App.tsx` `editorOptions`（:653-679）：
   - 删除 `defaultLivePreview: overScale ? false : undefined`（恢复默认 undefined = live）。
   - 删除 `plainText: readOnly`（readonly 档挂 Markdown 语言，`readOnly: true` 保留）。
2. `packages/engine/src/index.ts`：删除 `EngineOptions.plainText` 及 `editorExtensions` 中的对应分支（emojiCompletion/listKeymap 不再可被裁剪）；`apps/desktop/src/Editor.ts` 的 `CreateEditorOptions.plainText` 与传参同删。
3. `applyDocumentScalePolicy`（App.tsx:688-713）：删除 `try { view.dispatch(setLivePreview(false)) } catch {}`（保留 `safeModeChoiceRef` 语义：用户本会话手动切过模式的 tab 不受策略影响——现用于跳过强制 source，改为跳过任何模式强制，本任务后策略不再切模式，字段保留给未来使用并在注释说明）。`safeModeTabsRef` 仍标记（驱动渲染预算/安全渲染/按需字数）。
4. `applyRenderBudgetFor`（App.tsx:613-618）：若 Task 3 未接线则此处补 `setSafeModeRendering`。
5. LargeDocBanner（找到组件文件）：安全模式文案从「源码模式」语义改为「渐进渲染（视口优先）+ 按需字数」语义，readonly 变体说明只读 Live。i18n 文案同步（查 `apps/desktop/src/i18n*`）。
6. 测试更新：
   - `apps/desktop/test/App.largeDoc.test.tsx`：>50k 行 / >10MiB 断言改为「默认 live + 安全渲染标记 + 预算 60 + 横幅 + 按需字数」；`safeModeChoiceRef` 手动切 source 后不被回切。
   - `apps/desktop/test/App.largeDocOpen.test.tsx`：HUGE 档断言从 plain-text 只读改为「readOnly + live 渐进」；流式/取消/惰性恢复用例不回归。
   - 其它引用 `plainText` 的测试（grep `plainText` 全仓）同步清理。
7. 文档：
   - `docs/superpowers/specs/2026-08-19-05b-large-doc-open-design.md` 追加「实现变更附录（2026-08-20）」：LARGE 默认 Live（渐进）、HUGE 只读 Live（plainText 移除）、内存权衡、依据（用户决策）。
   - `docs/manual-qa.md` 增补：50MB 打开即 Live 渐进渲染（视口先出、滚动就近补齐、无冻结）、只读档 Ctrl+E、切换用例。

验证：`pnpm test` + `pnpm --filter @omd/desktop test`。

## Task 7: 桌面 — 大纲缓存（切换时延）

1. `apps/desktop/src/App.tsx`：
   - 新增 `docVersionsRef: Map<number, number>`（per-tab 版本号，`handleDocumentUpdate` 在 docChanged 时自增）；`resetTabDocument`/新建 tab 时重置为 0。
   - 新增 `outlineCacheRef: Map<number, {version: number, outline: OutlineItem[]}>`。
   - `refreshChrome(view)`（App.tsx:739-741）：命中缓存（tabId + version 匹配）直接 `setOutline(cached)`；未命中：非 over-scale 同步算并写缓存；over-scale 先 `setOutline([])`（或保留旧值）再 idle（`requestIdleCallback`/`setTimeout` 回退）算完写缓存并 `setOutline`（注意组件卸载/tab 切换后丢弃过期结果——比对激活 id）。
   - 150ms outline effect（App.tsx:959-965）同样先查缓存。
2. 测试（`apps/desktop/test/`）：缓存命中不重算（spy collectOutline 或版本号断言）、编辑后失效重算、over-scale 异步补齐、tab 切换不串数据。
3. `packages/engine/src/outline.ts` 不改（遍历本身受已解析区域限制）。

验证：`pnpm --filter @omd/desktop test`。

## Task 8: 桌面 — 保存后引用复用 + find 门控

1. `apps/desktop/src/documentSaveRunner.ts`（:268 附近）：保存流程开始时捕获 `const docAtStart = view.state.doc` 与已物化的保存内容字符串引用 `contents`；保存成功后：
   - `view.state.doc === docAtStart`（无编辑）→ `host.syncDoc(contents, tabId)`（复用同一字符串引用，保住 `docsRef`/`savedContents` 引用相等 → `sessionDirty` O(1)）。
   - 否则维持现状 `view.state.doc.toString()`。
   - 注意 `markSaved` 写入的 baseline 也应使用同一 `contents` 引用（检查 `session.ts` 的 savedContents 赋值路径，确保引用而非副本）。
2. `apps/desktop/src/App.tsx` `matchCount`（:2090-2100）：`findOpen` 且当前激活 tab over-scale（复用 `safeModeActive` 计算）时不跑 `collectMatches`，返回 `null`；FindBar/StatusBar 消费处显示占位（如 "—"，查现有 i18n 或加 key）。其余文档行为不变。
3. 测试：保存后无编辑时 `docsRef` 引用相等（`toBe`）；有编辑时仍更新；over-scale find 计数显示占位、普通文档计数不变。

验证：`pnpm --filter @omd/desktop test`。

## Task 9: Rust+TS — stat 版本探测（消除后台 50MB 全读）

对齐 05b §14.9 记录的后续项。

1. `apps/desktop/src-tauri/src/documents.rs`：`read_document_version`（及 watcher/poll 共用的探测路径）改为 stat 优先：维护 `State<Mutex<HashMap<PathBuf, (u64 mtime_ns, u64 size, DocumentVersion)>>>` 缓存；stat 的 (mtime_ns, size) 与缓存一致 → 直接返回缓存版本（不读文件）；不一致 → 现行全读 + blake3，更新缓存后返回。注意 async 命令 + `spawn_blocking` 模式（gotcha：同步命令占 Rust 主线程）。
2. IPC 契约：响应形状不变（现有 version 结构），若无多字字段新增则无需新序列化断言；若改动字段，三处同步 + Rust serde JSON 断言（工作区规则 7/8）。`apps/desktop/src/desktopServices.ts` 与 `App.tsx` pollFileTabs 消费方核对形状。
3. Rust 测试：缓存命中不读内容（可用 mtime 不可控性规避——用「同 stat 两次调用返回同 version 且内容改变+mtime 推进后返回新 version」的集成测法，或重构出纯函数单测 stat 比较）；行为回归：内容变更后版本变化（现有测试若有则保绿）。
4. `docs/memory/known-gotchas.md` 修订「probe 全读」相关条目为 stat 优先语义。

验证：`cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` + `pnpm --filter @omd/desktop test`。

## Task 10: 桌面+引擎 — 流式分块组装 Text（打开摄入）

1. `apps/desktop/src/App.tsx` `readSnapshotForOpen`（:1132-1158）：large 档流式接收时同步维护两个产物——`parts`（join 成镜像字符串，现状保留）与 `Text` 组装：每 chunk 按 `\n`/`\r\n`/`\r` 切行（跨 chunk 的 `\r` 携带：chunk 末尾为 `\r` 且非文件末尾时暂存到下一段），`Text.of(lines)` 后 `.append` 累积。返回 snapshot 附带 `docText?: Text`。
2. `apps/desktop/src/Editor.ts`：`CreateEditorOptions.doc: string | Text`；`createEditorState` 直接透传给 `EditorState.create({doc})`（CM 接受 Text，跳过内部全文 regex split）。
3. `openPath`/`loadLazyTab`/`resetTabDocument` 链路把 `docText` 传到 `editorOptions`；缺失时回退字符串。
4. `packages/engine/bench/open.bench.ts`：增加「Text 分块组装 vs 字符串 split」对比场景，记录摄入预算变化（advisory）。
5. 测试：跨 chunk 的 `\r\n`、行尾 `\r` 携带正确性（单测切行助手）；App 测试流式打开后内容与磁盘一致（现有流式用例扩展）。

验证：`pnpm test` + `pnpm --filter @omd/desktop test`。

---

## 收尾（所有任务完成后）

1. 全分支终审（SDD review-package MERGE_BASE..HEAD，最强模型档），ledger 中 minor/parked 清单一并裁定。
2. 文档核查：`known-gotchas.md`（新不变量「生产代码不得假设装饰已全量构建」、窗口化语义、`drainPendingLiveBuild` 仅测试可用、probe 条目修订）、`packages/engine/AGENTS.md` 与 `apps/desktop/AGENTS.md`（scale policy 新语义、safeModeRendering 全局）、README。
3. `pnpm verify`（engine tsc+vitest、desktop、cargo、链接）+ `pnpm --filter @omd/engine bench`。
4. superpowers:finishing-a-development-branch 呈现合并选项。

## 依赖顺序

Task 1→2→3→4→5（引擎链，串行）；Task 6 依赖 1-4；Task 7、8、9、10 相互独立，可在引擎链后穿插（SDD 不并行派发实现者）。
