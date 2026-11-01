# 表格格内光标

实时预览里单击 GFM 表格单元格时，渲染表保持挂载，插入点出现在被点中的那一格。管道符和分隔行只在用户按下块上的「查看源码」后出现。

这是对标 Typora 的编辑面。它替换 [表格两态契约](../../packages/engine/src/tables/AGENTS.md) 里「光标在表内就 `styleTableSource`」这一条，并采用 [2026-10-28 spike](../plans/2026-10-28-table-direct-editing-spike-results.md) 已经证明的事务契约：格内编辑没有自己的历史，每次落盘都是外层 `EditorView` 事务。

## 验收

1. 单击 `td`/`th` 后，`.omd-table table` 仍在。表头、边框、其余格子的渲染不变。被点中的格子里有 `.omd-table-caret`。文档主选区不落在这张表的源码范围内。
2. 焦点格里的链接、图片、行内公式：插入点在该语法节点内部时，该节点显示源码文本；插入点离开后恢复渲染。行内代码、加粗、斜体、删除线保持折叠，和正文路线 A 相同。
3. 在格子里打一个字再撤销，文档字节回到编辑前，含首次编辑触发的整表规范化。中文输入法只在 `compositionend` 提交一次。`</>` 按钮才进入 `styleTableSource`；光标离开表格后渲染表回来。

## 编辑面

三态，同一时刻只居其一：

| 状态 | 条件 | 呈现 |
| --- | --- | --- |
| 渲染 | 没有格内会话，也没有显式源码 | `TableWidget`，无插入点 |
| 格内 | `TableEditSession` 指向这一格 | `TableWidget` 仍在；这一格是渲染投影加插入点 |
| 整表源码 | `tableSourceRevealed` 且选区落在表内 | `styleTableSource`，widget 卸掉 |

格内插入点不是 CodeMirror 画在表格源码行上的光标。整表仍是 `Decoration.replace`，那些行没有可闪烁的文本。插入点是单元格投影里的 `.omd-table-caret`。键盘和输入法交给盖在插入点上的 1px 输入框，输入框的值是这一格的源码字符串。用户看见的是投影，不是输入框里的原文。

文档主选区不得停在未显式展开的表格内部。否则按键会改到被 widget 盖住的源码上，和格子里的插入点各改各的。方向键走进表格、查找落进表格、以及任何把折叠光标放进表内的路径，都改成打开对应格子的会话，并把主选区放到 `table.from`（表前）。整段盖住表格的选区维持今天的 `.omd-block-covered`，不打开会话。

## 格内投影

新增 `renderEditableCell(parent, source, caret, options)`。它走和 `parseCell` 同一个 Lezer 解析，不改导出用的 `CellNode`。

- 强调类（`Emphasis`、`StrongEmphasis`、`Strikethrough`、`Highlight`、`Underline`、`Kbd`、`Subscript`、`Superscript`）与 `InlineCode` 始终渲染，标记不展开。行内代码对节点内任意插入点都隐藏反引号，包括 `caret === from`。
- `Link`、`Autolink`、`Image`、`InlineMath`、`Escape`、`HardBreak`、`Entity`、`Emoji`、`FootnoteReference`：`caret >= from && caret < to` 时这一整个节点输出 `source.slice(from, to)`，否则照常渲染。判定在节点整体上做一次。
- 每个文本片段带 `data-from` / `data-to`（相对本格源码）。单击用命中节点的偏移换算格内下标，再写入输入框的 `selectionStart`。
- 在 `caret` 处插入 `.omd-table-caret`。输入框 `position: absolute`，宽高 1px，叠在这个插入点上，输入法候选窗跟着它。

`Escape` 关闭会话并还原这一格的渲染。`Tab` / `Shift-Tab` 沿用 `nextCell`。结构工具栏在非组词时先结束会话，再走现有的 `applyTableToolAt`。

## 事务

沿用 `tables/directEdit.ts` 的会话、`isolateHistory`、首次输入整表规范化、`compositionend` 提交一次、撤销重放 `restoreSession`。不新增第二套撤销栈。`experimentalTableDirectEdit` 不再作为默认开关：实时预览的 `editorExtensions()` 始终挂上这套会话。显式传入 `experimentalTableDirectEdit: false` 的测试和只读路径保持关闭。

显式源码用 `StateEffect` `revealTableSource`。`</>` 的 `mousedown` 在派发选区进表的同一事务里带上它。选区离开表格时字段回到 false。

## 不做

列宽拖拽、矩形选择、格内富文本粘贴、多光标、复杂 HTML 表。这些留下一版，不塞进本设计。

## 文档

实现时改三处契约，不另写一份平行说明：

- `packages/engine/src/tables/AGENTS.md` 的两态改成上面的三态。
- `docs/memory/gotchas-engine.md` 里「不要格内 input」改成：输入框只做输入法锚点，可见内容来自 `renderEditableCell`，历史只在外层事务。
- `docs/manual-qa.md` 增加本文件三条验收的手工项。
