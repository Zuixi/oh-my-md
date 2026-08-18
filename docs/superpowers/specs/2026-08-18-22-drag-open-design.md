# 22 拖拽 .md 文件到窗口打开 设计

**日期：** 2026-08-18
**状态：** 已确认，随本轮实现
**路线图关联：** 日常体验长尾（2026-08-18 产品化差距收敛计划 Phase 2.4）

## 目标

把 Markdown 文件拖到应用窗口直接打开（复用现有 `openRecent` 打开链路，脏标签确认、最近文件、文件树展开全部继承）。

## 方案与约束

- **通道选择**：图片拖入走 HTML5 drop（`imagePaste.ts` 的 `dataTransfer.files`，WebKit 下 File 对象无磁盘路径）。打开 .md 必须有真实路径才能保存回原文件，因此走 **Tauri 原生 `onDragDropEvent`**（payload `paths`）。两通道并存：图片继续走 HTML；.md 走原生事件，扩展名过滤复用 `constants.ts` 的 `MARKDOWN_EXTENSIONS`。
- **服务接口**：`desktopServices.listenDragDrop?: (handler: (paths: string[]) => void) => () => void`，实现用 `getCurrentWebview().onDragDropEvent`，只转发 `type === "drop"` 的 paths。与 `listenMenu`/`listenOpenFile` 同构（可选方法 + App useEffect 守卫 + ref 防过期闭包）。
- **非图片非 md 的路径忽略**（不弹错）。
- 已打开相同路径的文件时由 `runOpen` 既有逻辑聚焦已有标签。

## 非目标

- 拖入文件夹（作为工作区打开）。
- 原生通道的图片插入（HTML 通道已覆盖；若未来 `dragDropEnabled` 行为变化需统一迁移，另行规格）。
- 多文件批量打开为多标签（v1 只取第一个 md，避免拖一堆文件的误开风暴）。

## 测试矩阵

- `App.nativeOpen.test.tsx` 增用例：drag-drop 事件携带 md 路径 → 打开该文件；携带 .txt 路径 → 忽略。
- 服务层实现因依赖 `@tauri-apps/api/webview` 无法在 happy-dom 单测（与 listenMenu 同待遇，无既有单测）。

## 手动 QA

manual-qa.md：拖 .md 到窗口 → 打开；拖图片 → 仍插入 assets（回归）；拖 .txt → 无反应。

## 对后续规格提供的接口

`listenDragDrop` 服务形状；文件夹拖入工作区可复用同一通道。
