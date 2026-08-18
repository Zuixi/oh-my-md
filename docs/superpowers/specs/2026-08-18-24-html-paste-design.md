# 24 HTML 富文本粘贴 → Markdown 设计

**日期：** 2026-08-18
**状态：** 已确认，随本轮实现
**路线图关联：** 日常体验长尾（2026-08-18 产品化差距收敛计划 Phase 2.6）；对齐 Typora/MarkText/Obsidian 的富文本粘贴

## 目标

从浏览器 / Word / Pages / Google Docs 复制内容粘贴时，把剪贴板的 `text/html` 转换为 Markdown 插入，而不是丢失格式或粘出 HTML 源码。转换用 **turndown + turndown-plugin-gfm**（与"不自造 parser"的既有哲学一致：Markdown 解析用 Lezer，HTML→Markdown 用成熟库）。

## 非目标

- 粘贴行为设置开关（v1 恒开启，后续按反馈加）。
- 图片外链化/下载内嵌（导出侧已有 remote-image 决策）。
- 自定义转换规则（turndown 规则集固定）。

## 方案（`packages/engine/src/paste/htmlPaste.ts`，纯 TS，可 happy-dom 单测）

- **懒加载**：turndown + gfm 插件动态 import 一次并缓存（KaTeX/Mermaid 同模式）。转换配置：`headingStyle: "atx"`、`codeBlockStyle: "fenced"`、`bulletListMarker: "-"`、gfm（表格/删除线/任务列表）。
- **`htmlPasteToMarkdown(clipboard)` 启发式**（可独立单测的纯函数）：
  1. 无 `text/html` → `null`（走默认粘贴）。
  2. 转换结果为空 → `null`。
  3. 转换结果去空白后 === `text/plain` 去空白 → `null`（纯文本复制场景，保持与旧行为逐字节一致）。
  4. 否则返回 Markdown（`<pre>` 由 fenced 规则自然产出代码块，覆盖 VS Code 复制）。
- **CM 扩展 `htmlPaste()`**：`EditorView.domEventHandlers` 的 paste 钩子；剪贴板含图片项时让位（桌面图片通道优先）；同步 `preventDefault` 并捕获选区，异步转换完成后 dispatch 插入（`userEvent: "input.paste"`）；结果为 null 时手动插入 `text/plain`（默认路径已被 prevent，语义等价）。
- 注册进 `editorExtensions`（emoji 补全之后）。

## 测试矩阵（`packages/engine/test/htmlPaste.test.ts`）

- 转换：标题/加粗/斜体/链接/列表/表格（gfm 管道）/删除线/`<pre>` → 围栏代码。
- 启发式：无 html → null；纯文本等价 → null；带格式 → Markdown。
- 回归：`pnpm test`（引擎 tsc + 全量）。

## 手动 QA

manual-qa.md：浏览器复制段落+链接+列表粘贴 → Markdown；VS Code 代码粘贴 → 围栏代码块；Word/Pages 复制粘贴；纯文本复制粘贴行为与旧版一致；截图粘贴仍走图片通道。

## 对后续规格提供的接口

`htmlPasteToMarkdown` 纯函数 + `htmlPaste` 扩展；未来"粘贴为纯文本"命令可复用同一转换器。
