# 23 notify 文件监听替代高频轮询 设计

**日期：** 2026-08-18
**状态：** 已确认，随本轮实现
**路线图关联：** 日常体验长尾（2026-08-18 产品化差距收敛计划 Phase 2.5）；父设计里"Rust 侧文件监听(notify)"的兑现——当前实现是 2s 轮询

## 目标

外部文件变更（其他编辑器/git/网盘）在 ~300ms 内反映到打开的标签与文件树，替代 2 秒轮询的主通道；轮询降级为 30s 兜底。**watcher 仍然只是提前通知，正确性依旧以保存时的 Rust fingerprint 双比较为准**（既有产品原则不变）。

## 非目标

- 移除轮询（保留 30s 兜底，watcher 丢事件时仍能收敛）。
- 监听未打开文件夹的任意路径。
- 事件去抖参数用户可配。

## 方案

**Rust（新模块 `watcher.rs`）**

- `notify` `RecommendedWatcher` + 事件线程：回调把变更路径送入 mpsc；线程内 300ms 窗口聚合、去重（上限 200 条），`app.emit("workspace-changed", paths)`。
- `set_watched_paths(&AppHandle, &[PathBuf])`：增量 diff（unwatch 消失路径 / watch 新路径），全量 canonicalize；watcher 与事件线程懒创建、进程内单例。
- `#[tauri::command] watch_paths(paths)`：入参上限 64 条，逐条 canonicalize（不存在的跳过）。
- `WatcherState` 由 setup `manage`；`diff_watches(current, next) -> (to_unwatch, to_watch)` 为纯函数可单测。

**前端**

- `desktopServices.ts`：`watchPaths?: (paths: string[]) => Promise<void>`（invoke）；`listenWorkspaceChange?: (handler: (paths: string[]) => void) => () => void`（listen `workspace-changed`）。
- App effect A（订阅）：收到事件 → `pollFileTabsRef.current()`（探全部打开标签 fingerprint，幂等且有界）+ 文件夹打开且搜索面板关闭时 `refreshTree(listDir)`。
- App effect B（watch 集）：`[folder, tabs]` 变化时发送 `Set(folder ∪ 不在 folder 内的已保存标签路径)`。
- `watchMs` 默认 2000 → 30000（仅兜底；测试显式传值不受影响）。

## 测试矩阵

- Rust：`diff_watches` 纯函数（增/删/不变/乱序）；`watch_paths` 上限与不存在路径跳过（经命令层薄封装，核心在 diff）。
- 桌面 harness：`listenWorkspaceChange` 触发 → `readDocumentVersion` 探测被调用、树 `listDir` 刷新被调用；`watchPaths` 在打开文件夹后收到该文件夹路径。
- 回归：既有 conflict 用例继续通过（runWatcher 轮询路径不受影响）。

## 手动 QA

manual-qa.md：外部编辑器改打开的文件 → 标签数秒内提示（不再等 2s 轮询）；git checkout 后文件树即时刷新；30s 兜底轮询仍在（临时移除 watcher 权限场景难造，以代码为准）。

## 对后续规格提供的接口

`workspace-changed` 事件（payload `string[]`）与 `watch_paths` 命令成为宿主感知磁盘变化的唯一通道；Quick Open/搜索的缓存失效可复用。
