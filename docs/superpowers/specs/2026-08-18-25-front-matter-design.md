# 25 YAML front matter（不透明块）设计

**日期：** 2026-08-18
**状态：** 已确认，随本轮实现
**路线图关联：** 日常体验长尾（2026-08-18 产品化差距收敛计划 Phase 2.7）；差距分析原将 front matter 列为后置，本轮解禁——静态博客（Jekyll/Hugo/Obsidian 迁移）用户的第一屏就是它

## 目标

文档顶部 `---\n…\n---\n` 块：Live Preview 折叠为 chip（"YAML front matter"，title 显示行数），点击/光标进入显示源码；源码零改写；大纲与字数统计不把它当正文。

## 非目标

- YAML 语法校验/高亮/字段面板（不引入 YAML 依赖； Typora 式字段视图属 V2）。
- front matter 内部 Markdown 解析（不透明，`#` 行不会变成标题）。
- 导出转义处理之外的任何 front matter 变换（导出原文保留）。

## 方案

- **解析**（`parse/frontMatter.ts`，仿 `MathBlock` 行间规则）：仅 `cx.lineStart === 0` 且首行恰为 `---` 时接管，`before: "HorizontalRule"`；吞到下一个 `---` 行；未闭合吞到 EOF（widget 容错同 math）。节点 `FrontMatter`（block）+ `FrontMatterMark`。
- **装饰**（`decorations/blocks.ts`）：光标不在块内 → `FrontMatterWidget` 块替换（chip）；选区覆盖 → 每行 `line:omd-front-matter` 弱化样式。`FrontMatter` 加入 `SELECTION_BLOCKS`（选区进出强制重建，与代码块/表格同规则）。
- **统计**（`stats.ts`）：`documentStats` 前置剥离开头 front matter 正则（`^---\n…\n---\n?`）；启发式与 CommonMark 的 hr 歧义同源，接受。
- **大纲**：FrontMatter 内容不进 Markdown 解析，天然无标题，无需改 `collectOutline`。

## 测试矩阵（`packages/engine/test/frontMatter.test.ts`）

- 光标离开 → `widget:block:front-matter`；光标在块内 → 行样式、无 widget。
- 文中段的 `---` 仍是分隔线（`widget:block:hr`）。
- 未闭合 front matter 吞到 EOF 仍成块。
- `collectOutline` 忽略 front matter 内的 `#` 行。
- `documentStats` 排除 front matter 文本。
- fixture `front-matter.md` 快照。

## 手动 QA

manual-qa.md：打开含 front matter 的文档 → chip 折叠、点击进入编辑源码、⌘E 切源码模式全显；正文 `---` 分隔线不受影响；字数不含 front matter。

## 对后续规格提供的接口

`FrontMatter` 节点名 + chip widget；字段面板/导出元数据注入（V2）可基于同一节点扩展。
