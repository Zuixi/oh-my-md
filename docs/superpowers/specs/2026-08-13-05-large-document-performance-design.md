# 05 Large Document Performance 设计

**日期：** 2026-08-18（§1-9 已实现）；§10（05a）2026-08-19 增补
**状态：** §1-9 已落地；§10 诊断完成、按独立计划实现
**父设计：** `docs/superpowers/specs/2026-08-10-oh-my-md-design.md`（尖刀之一："万行级文档流畅"）
**路线图：** `docs/superpowers/specs/2026-08-13-00-product-roadmap-design.md` Phase A-05

## 1. 目标与非目标

**目标**

1. 为"大文档性能"建立**可复现的基准与预算**，让发布页的"万行流畅"有数字背书：10k 行与 50k 行两档。
2. 消除每次输入的全量主线程工作（以基准数据驱动，而非预先优化）。
3. 多标签场景的内存与交互下限（10 标签 × 10k 行不得拖垮前台输入）。
4. 超大文档（>50k 行）进入可预测的"安全模式"而非卡死。

**非目标**

- Web Worker 解析（Lezer/CM6 装饰在主线程的约束未变；除非基准证明必须，另行规格）。
- 大纲/字数统计的虚拟化（当前 outline 面板按标题量渲染，50k 行标题数远低于行数；基准后再定）。
- 跨设备性能对比服务/遥测。

## 2. 当前代码证据与待替换行为

- 增量装饰已存在：`packages/engine/src/decorations/build.ts` 用 ChangeDesc 映射未变 spec、只重建脏区间；`SELECTION_BLOCKS` 只在选区进出代码块/表格/数学/HR/front matter 时强制重建。`test/incremental.test.ts` + `test/fixtures/large.md`（约 1500 行）是现有护栏。
- 块级渲染已有 debounce 与缓存：Code 150ms（`lang:src` HTML 缓存）、Mermaid 500ms、KaTeX 导出缓存；widget `eq` 已移除 `pos`。
- **未知项（本规格要补的证据）**：
  - 无 10k/50k 行基准——manual-qa 只有"~1500 行滚动流畅"的人工结论；
  - 每次输入的同步路径上还有什么全量工作（候选：`collectMatches`（查找条开着时全文档扫描）、`documentStats`（全文档逐字符）、outline 防抖后的全树遍历、文件树轮询间隔）；
  - 多标签内存与切换成本未测（每标签一个 EditorView + 状态）。

## 3. 用户流程与状态机

```text
打开 >30k 行文档 → 顶部一次性提示"大文档模式"（非模态）
  ├─ 正常路径：全部功能可用，基准预算内
  └─ 安全模式（>50k 行，基准证实时才做）：默认进入 Source 模式
        ├─ 块 widget 懒渲染阈值提高（视口 ±1 屏）
        ├─ 字数统计退化为按需（点击状态栏刷新）
        └─ 用户可手动切回 Live Preview（记住选择，本会话）
```

## 4. TypeScript/Rust 接口及错误语义

- 基准脚本 `packages/engine/bench/typing.bench.ts`（Vitest bench）：
  - 输入：生成器产出 10k/50k 行混合负载（标题/表格/代码块/数学/中文段落按 fixtures 比例）。
  - 指标：单键输入事务耗时 p50/p95（目标预算见 §6）、整树重解析耗时、装饰重建耗时、`documentStats` 耗时。
- 滚动/交互指标（Playwright/manual 脚本 `scripts/perf-smoke.mjs`，发布前人工跑）：
  - 打开-可输入时间、连续滚动 10s 掉帧率、多标签（10×10k）常驻内存（`performance.memory` 不可用则用进程 RSS）。
- 无新 IPC。安全模式阈值 `LARGE_DOC_LINES = 30000` / `SAFE_MODE_LINES = 50000` 进 `packages/engine/src/index.ts` 常量 + desktop `constants.ts`（drift test）。

## 5. 安全、无障碍、性能与迁移约束

- 基准必须可在 CI 跑且**不阻断**（advisory：记录历史 JSON，回归 >50% 才 warning）——CI runner 抖动大，硬门槛会误伤。
- 安全模式不得静默丢功能：提示条说明关闭了什么。
- 无障碍：性能优化不得移除 live region（NormalizationBanner 等）。

## 6. 自动化测试矩阵

| 用例 | 断言 | 位置 |
|---|---|---|
| typing p95 @10k 行 | < 16ms（60fps 帧预算） | `bench/typing.bench.ts` |
| typing p95 @50k 行（安全模式 Source） | < 16ms | 同上 |
| 装饰重建仅脏区间（既有） | 不回归 | `test/incremental.test.ts` |
| `documentStats` 大文档 | >8ms 则必须已按需化 | bench + 单测 |
| 安全模式阈值 drift | 两侧常量一致 | `test/crossLayerConstants.test.ts` |

## 7. 手动 QA

manual-qa 增"性能"节：50k 行样本打开/滚动/IME 输入/多标签切换人感记录；安全模式提示与退出；发布前跑 `scripts/perf-smoke.mjs` 记录数字进发布说明。

## 8. 文档更新

README 发布页引用基准数字；AGENTS.md engine 域增 bench 命令；known-gotchas 增基准抖动注意事项。

## 9. 对后续规格提供的稳定接口

基准脚本与预算表是 08 渲染打磨、AI（14）流式插入性能的验收工具；安全模式常量归 engine 所有。

---

## 10. 05a 追问：超大文档（10-20MB）逐键路径（2026-08-19 增补）

**状态：** Spec 05 落地后实测 10/20MB 文件追问"逐键 60ms 能否优化"而立。诊断先行，证据见 §10.1；实现为独立计划 `docs/superpowers/plans/2026-08-19-05a-huge-doc-typing.md`。

### 10.1 诊断证据（M-series 开发机，happy-dom + CM 6.43.8/6.12.4 源码级）

**引擎稳态没有问题。** 部分树（`treeLen < doc.length`）下 10MB/38 万行逐键事务 p95 = **1.5ms**（1MB 同口径 <1ms）。CM 的 idle worker 把后台解析钉在 `viewport.to + 100000`（`Work.MaxParseAhead`，@codemirror/language `languageWatcher.work()`），**生产环境永不补完全树**；打开 10MB 文档本身只需视口解析（`Work.InitViewport`=3000 字符起步）。

**完整树是陷阱，不是目标。** 任何把树补全的路径（`forceParsing(doc.length)`、对全文档 `ensureSyntaxTree`）会让此后每次编辑的 fragment 重启随文档规模增长：实测完整树下 1MB = 23.5ms、10MB = 70.6ms 每键。当前生产代码无此路径（仅 `test/helpers.ts` 用），**必须立为不变量：生产代码禁止把解析推进到 `doc.length`**。

**真实每键 O(doc) 成本全部在 desktop 应用层**（10MB 实测）：

| # | 路径 | 实测成本 | 说明 |
|---|---|---|---|
| 1 | `Editor.ts::reportEditorUpdate` 每键 `doc.toString()` | 5-15ms + 每键 10MB 字符串 GC churn | 把 CM Text rope 整体展平，仅为了把内容塞进回调载荷 |
| 2 | `App::saveRecovery` 每键全文档 Tauri IPC + 写盘 | 最大项（IPC 序列化 + fs 写 10MB/键） | `createRecoveryWriter` 无防抖、无去重；对照：自动保存本身 1500ms 防抖 |
| 3 | `syncDoc → setDoc` 每键 React setState | 重渲染 + state 持新 10MB 字符串 | React 官方/社区一致建议：高频编辑不要把文档内容写进组件 state |

**排除项（实测无害，记录避免重查）**：lineNumbers gutter（本应用未安装）；`lineWrapping`（viewport 限定，0.1-0.2ms）；`drawSelection`/`highlightSpecialChars`（MatchDecorator 全量重建 bug 于 CM 6.36.0 已修，本仓库 6.43.8）；gutters/docView 更新（viewport 限定）。用户最初假设"禁用行号/换行计算"经测量证伪——**大文档不需要禁用任何 CM 内建能力**。

**已知悬崖（不修，记录）**：无空行巨型单段（如 minified 文本粘进一段）是 lezer-markdown 的 O(块) 每键悬崖（26MB 单段实测 1.2-2.6s/键）；Markdown 正常写作天然分块，安全模式源码下同理。另：CM `LanguageState.apply` 的同步 `work(20ms)` 预算只在 `advance()` 之间检查——一次 advance 解析整个 leaf block，块太大时预算失效。

### 10.2 目标

1. 10MB/20MB 混合负载文档逐键 p95 < 16ms（engine 稳态基准口径 + desktop 每键路径零 O(doc) 工作）。
2. 恢复写入与文档大小、按键频率解耦：防抖 800ms trailing + 同内容去重（崩溃恢复语义允许 ≤800ms 丢失窗口；关闭标签本就 `forget`）。
3. 每键不再物化/传播整文档字符串：`EditorDocumentUpdate` 不携带 doc；App 以轻量版本号驱动重渲染，内容按 250ms trailing 物化，消费前同步 flush。

### 10.3 非目标

- Web Worker 解析（同 §1）。
- CM fragment 机制、lezer 块粒度改造（上游行为）。
- 巨型单段的 O(块) 悬崖（记 gotcha，遇真实样本再规格）。

### 10.4 设计

**接口变更：**

```ts
// Editor.ts —— 每键载荷去掉 doc（CM Text 引用也不传：跨层不泄漏 CM 类型）
interface EditorDocumentUpdate {
  tabId: number; documentId: number
  docChanged: boolean
  pendingNormalization: OrderedListNormalizationNotice | null
}
```

**App 数据流（拉取式）：**

```text
每键 docChanged → docVersion++（轻量 setState，驱动 statusbar 光标等）
              → pendingDocTabs.add(tabId)，250ms trailing 定时器
物化（定时器到点或 flushPendingDocs()）：对每个 pending tab 从
  viewsRef.get(tabId).state.doc.toString() 拉取 → syncDoc（docsRef/docRef/setDoc）
同步 flush 时机（拉最新内容，杜绝陈旧）：saveFile / save copy / 导出 /
  会话持久化 / 关闭标签 dirty 判定 / 打开新文件前的 dirty 判定 / 外部变更探测
```

**恢复写入：** `createRecoveryWriter({ debounceMs: 800 })`——per-tab trailing 防抖；连续编辑合并为一次写；同内容（与上次成功写比较）跳过；`flush()` 供 App 在关键路径强制落盘；`forget(tabId)` 取消挂起定时器。

**基准口径修正：** `measureTyping` 增加 `tree: "steady" | "complete"`（steady = 只强制解析到 `viewport.to + 100000`，镜像生产行为；complete = 现行全树，标注为 worst-case 上限参考）。基准用例两口径并列；README 性能表补 10MB/20MB 行。

### 10.5 约束与不变量

- **生产代码禁止 `forceParsing` / `ensureSyntaxTree` 推进到 `doc.length`**（完整树陷阱；engine 域规则 + gotcha 条目）。
- 防抖物化不得造成数据丢失：所有消费 docsRef 的路径前必须 flush；保存/导出/关闭拿到的是 view 当前内容。
- `pendingNormalization` 语义不变：立即传播（规范审查提示不防抖）。
- 每键路径不得回归：desktop 增测试断言「连续 emit 三次 docChanged → writeRecovery 恰一次（防抖后）」「防抖窗口内 saveFile 落盘内容含最后一次按键」。
- live region、错误提示等无障碍行为不变。

### 10.6 测试矩阵（增量）

| 用例 | 断言 | 位置 |
|---|---|---|
| recovery 防抖 | 3 次快速 save → 800ms 后恰 1 次 write；同内容重复 save 不再写 | `test/recoveryWriter.test.ts` |
| recovery forget/flush | forget 取消挂起写；flush 立即落盘 | 同上 |
| 每键不传 doc | EditorDocumentUpdate 无 doc 字段（tsc 强制） | 类型即契约 |
| 防抖窗口内保存 | saveFile 落盘内容 = view 最新内容（flush 生效） | `test/App.test.tsx` 增例 |
| typing p95 @10MB/20MB steady | < 16ms（advisory） | `bench/typing.bench.ts` |
| complete-tree 上限参考 | 数字记录，无预算断言 | 同上 |
| 生产禁全树 | grep 式护栏：src 下无 `doc.length` 传给 forceParsing/ensureSyntaxTree | engine 单测（读源码断言，防回归） |

---

## 11. 05b 追问：冷打开路径（2026-08-19 增补）

**状态：** 诊断与方案见独立规格 [`2026-08-19-05b-large-doc-open-design.md`](./2026-08-19-05b-large-doc-open-design.md)。05a 清除逐键 O(doc)；实测 50MB **打开**仍长时间无响应，根因在 JSON IPC 整文件传输 + React 多副本 + 主线程 split，非引擎冷解析。

**关系：** 05 = 逐键预算 + 安全模式；05a = 10/20MB 逐键路径；**05b = 10/20/50MB 冷打开 TTIE + lazy 会话 + 打开 UX**。

