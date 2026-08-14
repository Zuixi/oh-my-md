# FileTree / Layout Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除编辑器敲键路径上的全部树/大纲开销，让大文件夹的 FileTree 不成为性能瓶颈：行计算缓存、行组件 memo、outline 防抖、`expanded` 改 Set；轮询与展开去重；大目录视口虚拟化；打开文件自动展开定位；Rust 大扫描移出主线程。

**Architecture:** 三个独立滚动列的布局已落地（见 `21decb4`）。本计划不改布局语义，只改渲染管线：`visibleRows` 用 `useMemo` 缓存并在 `FileTree` 内以固定行高做视口裁剪；`TreeRow` 用自定义比较器的 `memo` 跳过未变行；outline 收集从"每击键全量遍历"改为"150ms 防抖 + 面板隐藏时零成本"；`expanded` 从数组改 `ReadonlySet` 消除 `visibleRows` 的 O(R×E) 热点。轮询每 2s 全量 `list_dir` 增加 `searchOpen` 守卫、in-flight 防重叠、内容未变跳过 commit；`toggleDir` 去重并发请求并在折叠后跳过写入。`list_dir` / `search_markdown` 改为 `async fn` + `tauri::async_runtime::spawn_blocking`，与 02 计划 Global Constraint 对齐。

**Tech Stack:** TypeScript 5.8, React 19 (memo/useMemo/useRef/useEffect), Vitest 3, Testing Library, happy-dom, CSS；Rust 2021, Tauri 2。

**Spec:** 设计决策内嵌本计划（不另开 design 文档）。产品基线见 `docs/superpowers/specs/2026-08-10-oh-my-md-design.md`（M3 文件树/大纲）。03 依赖 02 的 `appHarness.ts` watcher 测试路径。

**Prerequisite:** `docs/superpowers/plans/2026-08-13-02-conflict-safe-save.md` 与三栏布局 WIP（`21decb4`）已就绪。本计划在分支 `perf/filetree-layout` 上实施。

## Global Constraints

- 不改布局语义（三栏、固定列宽、独立滚动）；只改渲染管线与数据流。
- `visibleRows` / `setChildren` / `toggleExpand` / `pathsToRefresh` 保持纯函数、不可变更新；新状态（in-flight、scrollTop）必须放 ref 或 state，不进 `FileTreeModel`。
- 每次敲键路径不得包含 O(整棵可见树) 的计算或 O(文档) 的 outline 遍历；outline 仅在停顿或面板打开时收集。
- 轮询仅在其可见时运行；未变化的目录不得触发 `commitTree`；同一目录的并发 `list_dir` 必须去重。
- 虚拟化依赖固定行高（`ROW_HEIGHT` 与 CSS `.filetree-item` 高度一致）；行 key 保持 `entry.path`。
- 不启用 `indentOnInput`、`closeBrackets` 或通用 `autocompletion`。
- `list_dir` / `search_markdown` 的阻塞 IO 一律 `tauri::async_runtime::spawn_blocking`（02 计划约定）；JoinError 归 `String` 错误；前端调用点不变。
- 状态更新不可 mutation；函数 <50 行；文件 <800 行；命名常量代替魔法数字。
- Commit 命令只是建议边界；没有用户授权不得执行。

---

## File Map

```text
apps/desktop/src/fileTreeState.ts          expanded → ReadonlySet<string>
apps/desktop/src/FileTree.tsx              TreeRow memo；虚拟化滚动容器与视口裁剪；active 行滚动定位
apps/desktop/src/App.tsx                   useMemo rows；outline 防抖；轮询守卫/去重；toggle 去重；expandToPath
apps/desktop/src/styles.css                .filetree 自滚动容器、.filetree-tree、.filetree-item 固定行高
apps/desktop/src-tauri/src/workspace.rs    list_dir / search_markdown async + spawn_blocking
apps/desktop/src-tauri/src/lib.rs          命令注册不变（async 化）
apps/desktop/test/fileTreeState.test.ts    expanded 集合行为回归
apps/desktop/test/*                        既有 suite 无回归
docs/{manual-qa.md}                        M3 手测项补充（虚拟化滚动/自动展开）
```

---

### Task 1: 打字路径零成本（useMemo + TreeRow memo + outline 防抖 + expanded Set）

**Files:**
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/FileTree.tsx`
- Modify: `apps/desktop/src/fileTreeState.ts`

**Interfaces:**
- Consumes: `visibleRows`、`FileTreeModel`（fileTreeState）、`documentOutline`（Editor.ts）、`OutlineItem`
- Produces: 稳定 `treeRows` 引用、memo 化 `TreeRow`、防抖的 outline 收集、`ReadonlySet<string>` 的 `expanded`

- [ ] **Step 1: `App.tsx` 缓存 rows**
  - import 增加 `useMemo`。
  - 组件内新增：`const treeRows = useMemo(() => workspace.folder ? visibleRows(workspace.folder, treeModel) : [], [workspace.folder, treeModel])`。
  - render 中 `FileTree` 的 `rows` 改为 `treeRows`（原 App.tsx:739 内联 `visibleRows(...)`）。

- [ ] **Step 2: `FileTree.tsx` 的 `TreeRow` memo**
  - `import { memo } from "react"`。
  - `TreeRow` 改为 `const TreeRow = memo(function TreeRow(props) {...}, areEqual)`。
  - `areEqual(prev, next)`: 比较 `prev.row.entry === next.row.entry && prev.row.depth === next.row.depth && prev.row.expanded === next.row.expanded && prev.active === next.active`。
  - 注释说明比较器刻意忽略 `onOpenFile`/`onToggleDir`（闭包只读 refs，行为稳定；若改为读 state 需同步调整比较器）。

- [ ] **Step 3: outline 防抖 + 隐藏零成本（App.tsx）**
  - 顶部常量区新增 `const OUTLINE_DEBOUNCE_MS = 150`。
  - 删除无条件 `[doc]` effect（App.tsx:422-424 的 `refreshChrome(viewRef.current)`）。
  - 新增 effect 依赖 `[doc, outlineOpen, session.id]`：`if (!outlineOpen) return`；否则 `setTimeout(() => setOutline(documentOutline(viewRef.current)), OUTLINE_DEBOUNCE_MS)`，cleanup `clearTimeout`。
  - `activateTab` 内的 `refreshChrome(nextView)` 保留（切标签立即刷新）。

- [ ] **Step 4: `fileTreeState.ts` expanded 改 `ReadonlySet<string>`**
  - `FileTreeModel.expanded: ReadonlySet<string>`。
  - `emptyFileTree()` 返回 `new Set()`。
  - `toggleExpand` 构造新 `Set`（保留/删除 path）。
  - `rowsFor` 内 `model.expanded.has(entry.path)`。
  - `App.tsx` toggleDir 里 `next.expanded.includes(path)` → `next.expanded.has(path)`。
  - `fileTreeState.test.ts` 如未直接访问 `.expanded` 数组则不改（已有用例经 `toggleExpand`/`visibleRows` 覆盖）。

- [ ] **Step 5: 验证**
  - `pnpm --filter @omd/desktop test`（tsc + vitest）。
  - `pnpm --filter @omd/desktop build`。
  - `pnpm dev` 手测：大文档连续敲键（树+大纲开着）无卡顿；展开/折叠、切标签、开关大纲行为不变。

---

### Task 2: 轮询稳健性（守卫 + 防重叠 + 未变跳过 + toggle 去重）

**Files:**
- Modify: `apps/desktop/src/App.tsx`

- [ ] **Step 1: 树轮询 `searchOpen` 守卫 + in-flight 防重叠**
  - 轮询 effect（App.tsx:409-414）deps 增加 `searchOpen`；`searchOpen` 为真时 return。
  - 组件新增 `const treePollInFlightRef = useRef(false)`；`refreshTree` 开头 `if (treePollInFlightRef.current) return`，`try/finally` 复位。

- [ ] **Step 2: 内容未变跳过 commit**
  - `refreshTree` 循环内对每目录比较新 `entries` 与 `model.childrenByPath[path]`：长度相同且逐项 `name`/`path`/`is_dir` 全等则跳过该目录 `setChildren`。
  - 全部目录未变时直接 return，不调 `commitTree`。

- [ ] **Step 3: `toggleDir` 去重 + 折叠后失效**
  - 组件新增 `const pendingListDirsRef = useRef(new Set<string>())`。
  - `toggleDir`：需要拉取时先 `has` 查重，加入 `Set`；完成后 `delete`。
  - 完成时若目录已不在 `expanded`（用户已折叠）则跳过 `setChildren`。

- [ ] **Step 4: 验证**
  - `pnpm --filter @omd/desktop test` + `pnpm --filter @omd/desktop build`。
  - `appHarness` watcher 相关用例（`runWatcher`/`runExternalCheck`）无回归。

---

### Task 3: 大目录视口虚拟化（手动裁剪）

**Files:**
- Modify: `apps/desktop/src/FileTree.tsx`
- Modify: `apps/desktop/src/styles.css`

- [ ] **Step 1: CSS 滚动容器重构**
  - `.filetree`：`height: 100%; display: flex; flex-direction: column; overflow: hidden;`（title 固定）。
  - 新增 `.filetree-tree { flex: 1; min-height: 0; overflow: auto; position: relative; }`；`role="tree"` 移到该容器。
  - `.filetree-item`：`height: 26px; box-sizing: border-box;`（固定行高，与 ROW_HEIGHT 一致）。

- [ ] **Step 2: FileTree 视口裁剪**
  - 常量 `const ROW_HEIGHT = 26`、`const OVERSCAN = 10`。
  - 滚动容器 ref；`scroll` 事件 `setScrollTop(e.currentTarget.scrollTop)`；`ResizeObserver` 记录 `clientHeight` 为 `viewportH` state。
  - 计算 `start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)`、`end = Math.min(rows.length, Math.ceil((scrollTop + viewportH) / ROW_HEIGHT) + OVERSCAN)`。
  - 渲染：外层 spacer `<div style={{ height: rows.length * ROW_HEIGHT, position: "relative" }}>`，内部 `rows.slice(start, end).map((row, i) =>` 用 `style={{ position: "absolute", top: (start + i) * ROW_HEIGHT, left: 0, right: 0, height: ROW_HEIGHT }}` 包裹 `TreeRow`。
  - 保留 `aria-expanded`、Tab 焦点顺序；`scrollTop`/`viewportH` 初始用 `0`，首帧经 `ResizeObserver` 校正。

- [ ] **Step 3: 验证**
  - `pnpm --filter @omd/desktop test` + `build`。
  - `pnpm dev`：展开千级文件目录滚动无卡顿；折叠/展开/搜索切换正常；DOM 只含可见行。

---

### Task 4: 打开文件自动展开定位（auto-reveal）

**Files:**
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/FileTree.tsx`

- [ ] **Step 1: `expandToPath(path)`（App.tsx）**
  - 从 `workspace.folder` 到 `path` 父目录的祖先链，自顶向下逐级：`toggleExpand` 展开 + 若 `childrenByPath` 缺则 `await listDir` 填充，逐步 `commitTree`；失败静默（不阻断打开）。
  - 复用 Task 2 的 `pendingListDirsRef` 防并发。

- [ ] **Step 2: 接入 `openPath`**
  - `openPath` 成功路径（inNewTab 与重置当前 tab 两处，App.tsx:475-485）在 `revealFolder` 之后调用 `void expandToPath(nextPath)`。

- [ ] **Step 3: FileTree 滚动到活动行**
  - effect：`activePath` 变化时在 `rows` 中 `findIndex(r => r.entry.path === activePath)`；若不在视口内，设滚动容器 `scrollTop = index * ROW_HEIGHT`（复用 Task 3 行高）。
  - 用 ref 记录滚动容器，避免 effect 与虚拟化状态竞争。

- [ ] **Step 4: 验证**
  - `pnpm --filter @omd/desktop test` + `build`。
  - `pnpm dev`：打开深层文件 → 树自动展开祖先目录并滚动到该文件；从搜索面板打开同样生效。

---

### Task 5: Rust 大扫描移出主线程（conformance）

**Files:**
- Modify: `apps/desktop/src-tauri/src/workspace.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`

- [ ] **Step 1: workspace.rs 命令 async 化**
  - `list_dir`、`search_markdown` 内部同步逻辑保留为 `pub(crate)` 同步函数（现有实现即同步，无需抽取）。
  - 命令改为 `pub async fn`，内部 `tauri::async_runtime::spawn_blocking(move || sync_fn(...))` 包裹，`await` 后 `.map_err(|e| e.to_string())`（JoinError 映射字符串错误）。

- [ ] **Step 2: lib.rs 注册**
  - handler 注册名不变（`list_dir`、`search_markdown`），无参数签名变化；capabilities 不变。

- [ ] **Step 3: 验证**
  - `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`（workspace.rs 既有同步用例保留）。
  - `pnpm --filter @omd/desktop test`（前端类型/调用不变）。
  - 确认 `tauri::generate_handler!` 接受 async 命令且运行时不改动。

---

## 验证清单

| 项 | 命令/方式 |
|---|---|
| 前端类型+单测 | `pnpm --filter @omd/desktop test` |
| 构建 | `pnpm --filter @omd/desktop build` |
| Rust | `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` |
| 引擎（不受影响，保险） | `pnpm test` |
| 手动 | `pnpm dev`：大文档连续敲键（树+大纲开着）流畅；千级文件目录滚动无卡顿；打开深层文件自动展开定位；2s 轮询无感；搜索时树停轮询 |

## 提交切分（每任务一 commit，`perf: <why>`）

1. `perf: keep file tree and outline off the keystroke path` — Task 1
2. `perf: guard and dedupe file tree polling` — Task 2
3. `perf: virtualize large file tree rows` — Task 3
4. `perf: reveal opened files in the file tree` — Task 4
5. `perf: move folder scans off the main thread` — Task 5

## 风险与注意

- Task 3 滚动容器归属变化：`.filetree` 变为自滚动容器后，`.sidebar-primary` 不再承担树滚动；SearchPanel 仍走 `.sidebar-primary` 滚动，不受影响。需真机确认无嵌套滚动条。
- Task 3+4 共用 `ROW_HEIGHT` 与行索引，先 3 后 4；索引逻辑复用。
- Task 1 的 handler 忽略比较依赖"闭包只读 refs"契约，改动 handler 读取方式需同步调整比较器。
- Task 5 只做执行位置迁移，不改变命令签名与前端调用；若已有线程池调度，此改动为纯保险。
