# oh-my-md v0.1 (M1) 手动 QA 清单

M1 交付物：一个能 Cmd+O 打开 .md → Live Preview 编辑 → Cmd+S 保存、Cmd+E 切换 live/source 模式的桌面 App。以下项自动化成本高、人眼判断快，发布前逐项过一遍。

## 启动
- [ ] `pnpm dev` 能起 Tauri 窗口，无构建错误
- [ ] 窗口打开即见一个空 CM6 编辑器，光标可定位

## 编辑核心
- [ ] 中文输入法合成期不抖动、不吞字（拼音/双拼各试一次）
- [ ] 在 `**粗体**` 中间打字，光标贴近 `**` 边缘时语法展开、离开后重新折叠
- [ ] 撤销/重做（Cmd+Z / Cmd+Shift+Z）正确，跨模式不串味
- [ ] 链接 URL 区光标进入时展开、离开折叠

## 模式切换
- [ ] Cmd+E 在 live/source 间来回切换，文本零丢失、光标位置合理
- [ ] 切换后滚动位置保持

## 文件 IO
- [ ] Cmd+O 打开含中文路径的 .md，内容正确
- [ ] Cmd+S 保存后用别的编辑器打开，格式无损
- [ ] 另存为新文件（无 path 时 Cmd+S）工作正常

## 性能
- [ ] 打开 `packages/engine/test/fixtures/large.md`（~1500 行），滚动流畅、首次渲染 < 1s
- [ ] 快速连续敲键无卡顿（KaTeX/Mermaid 等大块在 M2，本版不涉及）

## 渲染（对照 styles.css 类名）
- [ ] 各级标题字号正确，`#` 折叠（ATX 标题）
- [ ] 加粗 / 斜体 / 删除线 样式正确，语法标记被折叠
- [ ] 行内代码 背景等宽字体
- [ ] 链接 蓝色，URL 折叠，光标进入展开
- [ ] 任务复选框可点切换，状态写回源码（`[ ]`⇄`[x]`）
- [ ] 引用块左边框，`>` 折叠
- [ ] 水平线样式

## 已知限制（M1 范围，非缺陷）
- 表格：仅解析，不渲染表格 widget（M2 实现 TableWidget）
- 脚注：未实现自定义解析扩展（`[^id]` 当前作为文本/链接引用处理；自定义脚注解析在 v1 前补齐）
- 图片 / 数学公式 / Mermaid / 代码高亮：M2
- 文件树侧边栏 / 大纲 / 全局搜索 / 导出 / 主题切换 UI：M3

## 自动化测试基线（已通过）
- 引擎单测：`pnpm --filter @omd/engine test` → 27 个测试全绿
- 前端构建：`pnpm --filter @omd/desktop build` → 成功
- Rust 构建：`cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml` → `Finished`
