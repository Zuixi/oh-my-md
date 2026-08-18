# 05 Large Document Performance 设计

**日期：** 2026-08-18
**状态：** 待用户审核（本轮只立规格，不实现）
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
