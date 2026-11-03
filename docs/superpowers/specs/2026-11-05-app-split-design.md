# App.tsx 拆解（P1–P5）设计

**日期：** 2026-11-05

**状态：** 已批准；P1–P5 由 pi worker 执行、主 agent 逐阶段验收

**范围：** `apps/desktop/src/App.tsx`（2832 行）的结构化收缩。目标是把五个
高内聚职责搬出组合根，同时不改变任何可观察行为。

## 1. 问题

`App.tsx` 是冻结热点（AGENTS.md「Module Size & Ownership」），但 merge 叠加
已两次撞线（2861 > 基线 2858）。根因不是行数，而是**组合根承担了五个领域
控制器的职责**，靠约 90 个 state/ref 的共享闭包互相读写。

## 2. 北极星（终态方向，不在本计划内实施）

```text
App = 纯组合根 + JSX 装配
 ├─ workspaceStore      （tabs / folder / dirty / session）
 ├─ documentsStore      （内容 / saveState / lazy 物化）
 ├─ fileTreeController  （自有 treeModel + 树操作）
 ├─ findReplaceController
 └─ uiPrefs             （theme / sidebar / outline / ...）
```

**为什么不是现在直接做：** 90 个 ref 的重新分仓是 big-bang 迁移；挂载顺序、
flush 时序、在途打开作废等不变量靠注释维系，happy-dom 测不出回归。绞杀者
路径（P1–P5）每步行为不变、测试全绿、可独立回滚。

**演化判据（写给未来执行者）：** host 桥接是过渡形态，不是终点。当某个
host 的 getter 数量开始收敛（≤4）且其读写集中在一组自洽状态上，就把它
升级为**自有状态的 controller/store**（参考 `editorStatusStore` 的外部
store 模式）；当 getter 持续 ≥8 且互相纠缠，说明缝切错了轴，应按状态
所有权重组而非继续加 getter。**禁止把「注入 getter 的桥」当成终态固化。**

## 3. 阶段划分（风险递增）

| 阶段 | 目标模块 | 形态 | 搬走 | App.tsx 预期 |
|---|---|---|---|---|
| P1 | `useFindReplace.ts` | custom hook | 查找替换的 14 state + 10 镜像 ref + 7 函数 | −~180 |
| P2 | `fileTreeActions.ts` | 桥接工厂（host 注入） | 7 个树操作函数 | −~220 |
| P3 | `documentOpen.ts` | 协调器（自有状态） | `openPath` 链路；令牌/in-flight/失效集私有化 | −~260 |
| P4 | `appSessionInit.ts` | 纯动作模块 | 会话恢复/草稿/初始设置 3 个 async 流 | −~120 |
| P5 | `appCommands.ts` | 数据工厂 | `allCommands` 40+ 条目 → `buildAppCommands(ctx)` | −~140 |

量化预期：2832 → ~1900。编辑器装配（`useEditorHost`，−230）与 JSX 拆分
**不在本计划**：JSX 拆点是重渲染边界，happy-dom 无法验收，需 e2e 布局
套件单独护航（未来 P6/P7，另立计划）。

## 4. 不变量（每个阶段共同遵守）

1. **行为不变**：`App.test.tsx`（1403 行）、`appHarness.ts`、其余 111 个
   测试文件**一行不改、全部保持绿**。要改测试 = 缝选错了。
2. **只搬不改**：函数体原样搬运（含注释）；搬运 PR 与任何重构 PR 分离。
3. **effects 留在 App**：抽的是能力，不是副作用时机；`useEffect` 依赖
   数组不新增。
4. **host 给 getter**：`() => ref.current`，绝不按值快照。
5. **每阶段独立提交**：`pnpm --filter @omd/desktop test` + `tsc --noEmit`
   + `pnpm check:quality` 全绿后 commit，再进下一阶段。
6. App.tsx 之外的模块一律 ≤500 行目标 / 800 硬上限。
