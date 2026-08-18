# oh-my-md 与业内主流 Markdown 编辑器差距分析

**日期：** 2026-08-16  
**状态：** 已确认，作为后续规格拆分依据  
**路线图：** `docs/superpowers/specs/2026-08-13-00-product-roadmap-design.md`  
**父设计：** `docs/superpowers/specs/2026-08-10-oh-my-md-design.md`

> **状态更新（2026-08-18）：** 下文「必要缺口」表的 P0/P1 已全部由规格 [06](./2026-08-16-06-core-writing-experience-design.md)/[07](./2026-08-16-07-markdown-navigation-design.md)/[09](./2026-08-16-09-workspace-operations-design.md)/[11](./2026-08-16-11-export-pipeline-design.md)/[15](./2026-08-16-15-table-editing-design.md)/[16](./2026-08-16-16-image-insert-design.md) 落地。新一轮差距收敛（发布硬门槛与日常体验长尾）由 2026-08-18 系列规格 19–26 与 13-B 的 Apple 账号 TODO 跟踪；本文其余内容仅作历史快照保留。

## 对标范围

对标对象是 **Typora / MarkText** 这一类「单文件为中心、Live Preview 写文档」的桌面编辑器，不是 Obsidian 的库/双链/插件生态。

证据来源：当前仓库实现与 `docs/manual-qa.md`、产品规格；[GFM spec](https://github.github.com/gfm/)；[Typora](https://typora.io)；[2026 编辑器对比](https://unmarkdown.com/blog/best-markdown-editors-2026)；[MarkText 能力表](https://www.markdownguide.org/tools/mark-text)。

## 结论

编辑内核与文件可靠性已接近主流。日常写作完成度还不够当主力编辑器。

| 层 | 判断 |
|---|---|
| 引擎 / Live Preview / GFM 主干 | 达到 |
| 保存冲突 / 恢复 / 会话 | 达到，部分优于同类 |
| 日常写作（查找、表格编辑、图片、导出保真、中文统计） | 未达到 |
| AI / 双链 / 插件 | 规格里的后置项，不是当前短板 |

现在是可靠的 Typora 向 Alpha/Beta：打开、写、预览、保存已经专业；缺的是每天都会碰到的写作工具。

## 已达到主流水准

- Live Preview + 源码切换（`⌘E`），装饰方案对标 Typora。
- CommonMark + GFM 主干：标题、列表、引用、代码、链接、表格预览、任务列表、删除线、autolink。
- 扩展：脚注、KaTeX、Mermaid、`==高亮==`、gemoji、HTML 实体、CJK `__`。
- 格式快捷键与命令面板。
- 多标签、文件树、大纲、文件夹搜索、最近文件、原生菜单。
- 亮/暗主题、自定义 CSS、Focus / Typewriter。
- 截图粘贴写入 `assets/`，相对路径，失败不插源码。
- 冲突保存、Compare / Overwrite / Save copy、崩溃恢复。
- 设置持久化与会话恢复。

架构方向正确：CM6 + Lezer 装饰、引擎与宿主分离、Tauri 管文件。

## 必要缺口（按优先级）

这些是 Typora / MarkText / VS Code 用户每天会用、缺了就不能当主力的能力。

| 优先级 | 缺口 | 当前证据 | 对应规格 |
|---|---|---|---|
| P0 | 文档内查找/替换 | `⌘F` 绑定文件夹搜索；无 `@codemirror/search` | [06](./2026-08-16-06-core-writing-experience-design.md) |
| P0 | 中文友好字数 | `wordCount` 用 `split(/\s+/)`，整段中文算 1 词 | 06 |
| P0 | 拼写检查空开关 | Settings 有 `spellcheck`，编辑器从未挂属性 | 06 |
| P0 | 列表续写/缩进 | 刻意未开 `indentOnInput`；无列表专用 Enter/Tab | 06 |
| P1 | 表格就地编辑 | `TableWidget` 只渲染，点进去回源码 | [15](./2026-08-16-15-table-editing-design.md) |
| P1 | 图片拖入/选文件 | 仅剪贴板粘贴 | [16](./2026-08-16-16-image-insert-design.md) |
| P1 | 导出保真 | `exportHtml` 把公式/Mermaid 收成 `<code>`，代码无高亮 | [11](./2026-08-16-11-export-pipeline-design.md) |
| P1 | 文件树 CRUD | 只能打开，不能新建/重命名/删除/移动 | [09](./2026-08-16-09-workspace-operations-design.md) |
| P1 | 脚注与本地链接导航 | `#` 锚点与外链可点；脚注与 `.md` 文件未跳转 | [07](./2026-08-16-07-markdown-navigation-design.md) |

## 明确后置（本轮不做）

- YAML front matter、下标/上标、Smart Punctuation、通用 HTML 块。
- 图床、DOCX / Epub、幻灯片。
- Vault / 双链 / Graph / 插件。
- AI 块操作（M4）。
- Windows / Linux、自动更新、完整无障碍（发布工程）。
- 开启通用 `indentOnInput` / `closeBrackets` / `autocompletion`（与 Live Preview 冲突；列表续写用专用 keymap）。

## 实施顺序

1. 06 Core Writing — 查找替换、统计、拼写检查、列表续写。
2. 07 Navigation — 脚注与本地 Markdown 链接。
3. 15 Table editing — 单元格编辑与增删行列。
4. 16 Image insert — 拖放与选文件，复用现有 `write_image`。
5. 09 Workspace operations — 侧边栏文件操作。
6. 11 Export pipeline — 导出含公式/高亮/图表。

每一项独立成规格与计划，不合并成巨型计划。
