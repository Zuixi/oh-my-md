# 21 Quick Open（⌘P 文件名快开）设计

**日期：** 2026-08-18
**状态：** 已确认，随本轮实现
**路线图关联：** 日常体验长尾（2026-08-18 产品化差距收敛计划 Phase 2.3）；对标 Typora/VS Code 的文件名快开

## 目标

⌘P（或 File 菜单「Quick Open…」）弹出文件名过滤弹层：列出当前工作区文件夹内全部 Markdown 文件（复用文件夹搜索的 gitignore 感知遍历），子串过滤（大小写不敏感，与命令面板同规则），↑↓ 选择、Enter 打开、Esc 关闭。

## 非目标

- 模糊评分排序（fzf 式评分）——先与命令面板一致的子串过滤。
- 跨文件夹/全局历史文件搜索（只查当前打开的文件夹）。
- 最近打开文件混排。

## 接口

**Rust**（`workspace.rs`，复用 `search_markdown` 的 WalkBuilder 配置：hidden/gitignore/gitexclude、5MB 上限）：

```rust
pub struct QuickOpenResponse { paths: Vec<String>, truncated: bool }  // 单词字段，无需 camelCase
#[tauri::command] list_markdown_files(root) -> QuickOpenResponse      // 上限 5000 条，超限 truncated
```

**TS**（`desktopServices.ts`）：`listMarkdownFiles?: (root: string) => Promise<QuickOpenResponse>`；`src/QuickOpenModal.tsx` 复用 `.palette-*` 样式类，显示相对文件夹的路径。

**快捷键/菜单**：`WINDOW_SHORTCUTS` 增 `{ id: "quick-open", keys: "⌘P", key: "p" }`；menu.rs File 菜单 `quick-open` 项（CmdOrCtrl+P，排在 Open… 之后）；`MENU_TO_COMMAND["quick-open"]`；命令面板同名命令。crossLayerMenu drift 测试自动覆盖 accelerator↔shortcut 一致性。

无文件夹打开时：命令触发 transient 提示 `quickOpen.noFolder`，不弹空弹层。

## 测试矩阵

- Rust：JSON 序列化断言（paths/truncated）；遍历只收 Markdown、忽略隐藏文件、按路径排序、越界路径拒绝。
- 桌面 harness：⌘P 打开弹层（有文件夹时）→ 选择 → 调用打开；无文件夹时显示提示不弹层；列表截断提示渲染。
- crossLayerMenu/crossLayerConstants：自动（新菜单项有 accelerator ↔ WINDOW_SHORTCUTS 条目）。

## 手动 QA

manual-qa.md：⌘P 弹层过滤、↑↓/Enter/Esc、打开文件、无文件夹提示、5000+ 文件截断提示。

## 对后续规格提供的接口

`QuickOpenResponse` 形状；未来模糊排序只改 `QuickOpenModal` 的过滤函数。
