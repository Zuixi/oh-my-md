# oh-my-md 手动 QA 清单

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
- [ ] 当前文档 dirty 时 Cmd+O 会确认；取消后路径、内容、dirty 状态均不变
- [ ] 快速连续打开两个文件时，较晚返回的旧读取结果不会覆盖当前文档
- [ ] 打开另一文件后 Cmd+Z 不会撤回到前一文件；撤销到已保存内容时 dirty 标记消失
- [ ] Cmd+S 保存后用别的编辑器打开，格式无损
- [ ] 保存期间继续编辑时，本次只保存捕获的快照且界面继续显示 dirty；再次保存后落盘最新内容
- [ ] 另存为新文件（无 path 时 Cmd+S）工作正常

## 性能
- [ ] 打开 `packages/engine/test/fixtures/large.md`（~1500 行），滚动流畅、首次渲染 < 1s
- [ ] 快速连续敲键无卡顿；含多个代码/公式/图表块的文档滚动仍流畅

## 渲染（对照 styles.css 类名）
- [ ] 各级标题字号正确；ATX 的 `#` 与 Setext 的 `===` / `---` 在光标离开后折叠
- [ ] 加粗 / 斜体 / 删除线 样式正确，语法标记被折叠
- [ ] 行内代码 背景等宽字体
- [ ] 链接 蓝色，URL 折叠，光标进入展开
- [ ] 任务复选框可点切换，状态写回源码（`[ ]`⇄`[x]`）
- [ ] 无序列表 marker 折叠为 `•`，有序列表保留数字；任务项不叠 bullet
- [ ] 嵌套列表逐级缩进，换行的续行对齐到正文（悬挂缩进）；光标进入该行时源码缩进显露
- [ ] 围栏/缩进代码块整行等宽底色；块内 `**` 等行内语法不折叠；高亮属 M2
- [ ] 引用块左边框，`>` 折叠
- [ ] 水平线样式
- [ ] 脚注引用上标；脚注定义的 `[^id]:` 标记折叠；4 空格缩进的续行归入定义（不显示为代码块）

## M2 块渲染
- [ ] 表格渲染为 HTML 表格，对齐正确；点 ✎ 回源码
- [ ] 代码块高亮（js/ts/rust 各试一个）；未知语言降级纯文本；光标进入显源码
- [ ] `$$` 块公式与 `$` 行内公式渲染；错误公式显示错误+原文不白屏
- [ ] ```mermaid 块渲染图表；语法错时显示错误+原文
- [ ] 截图粘贴生成 assets/ 文件并渲染为图片；图片加载失败显示占位文本
- [ ] 图片读取或写入失败会显示错误且不插入 Markdown
- [ ] 图片写入期间移动光标仍插入到原选择；切换路径、切换文档或继续编辑不会写入错误文档
- [ ] 快速并发粘贴不会并发写入；过期操作会明确报错
- [ ] PNG/JPEG/WebP 使用匹配扩展名；GIF、未知格式和超过 10 MiB 的图片被拒绝
- [ ] 表格/代码块在 blockquote 内不炸（冲突过滤兜底）

## 已知限制（当前范围，非缺陷）
- 表格单元格内的行内格式渲染为纯文本（block replace 内叠不了行内装饰）
- 代码块编辑态无高亮（光标进入即源码形态；Typora 式就地高亮成本高，v2 再议）
- math 仅支持 `$$`/`$` 定界符
- 脚注：空行仍会结束定义（跨空行的多段脚注暂不合并，见 footnotes.ts 的 ponytail 注记）
- 文件树侧边栏 / 大纲 / 全局搜索 / 导出 / 主题切换 UI：M3

## 自动化验证命令
- 引擎单测：`pnpm test`
- Desktop 类型检查与自动化：`pnpm --filter @omd/desktop test`
- 前端构建：`pnpm --filter @omd/desktop build`
- Rust 测试：`cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
- Rust 构建：`cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml`

测试数量以命令当次输出为准，不在本清单固定。

## 最近一次验证记录

- 日期：2026-08-13
- 自动化已通过：`pnpm test`、`pnpm --filter @omd/desktop test`、`pnpm --filter @omd/desktop build`、`cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`、`cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml`、`git diff --check`。具体用例数以当次命令输出为准。
- 交互式 M2 QA：本环境未执行 `pnpm dev` GUI 清单，上方交互项保持未勾选。
