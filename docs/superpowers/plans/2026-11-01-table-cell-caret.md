# 表格格内光标 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 单击 GFM 单元格时渲染表保持不动，插入点出现在该格已渲染的文字里，撤销仍走外层文档事务。

**Architecture:** 整表继续用 `TableWidget` 替换源码行。格内插入点是投影里的 `.omd-table-caret`，1px 输入框只接收键盘和输入法，并调用已有的 `tableCellInputSpec`。`tableSourceRevealed` 为真且选区在表内时才走 `styleTableSource`。文档主选区不停留在未展开的表格内部。

**Tech Stack:** TypeScript、CodeMirror 6、Lezer Markdown、Vitest + happy-dom。

**Spec:** [docs/superpowers/specs/2026-11-01-table-cell-caret-design.md](../specs/2026-11-01-table-cell-caret-design.md)

## Global Constraints

- 单元格语义只有 `parseCell` 一处。本计划的编辑投影可以另走一棵带偏移的 Lezer 遍历，不得给导出用的 `CellNode` 加字段，也不得在 widget 里用正则识别 Markdown。
- 格内编辑的落盘只有 `tables/directEdit.ts` 的外层事务。输入框不记历史。
- `decorations/widgets/table.ts` 已到增长上限。新的投影、命中和输入法锚点放进新文件 `decorations/widgets/tableCellEdit.ts`。`table.ts` 只保留调用。
- 生产代码禁止 `ensureSyntaxTree` / `forceParsing`。单元格解析沿用 `parseCell` 已有的单格 `Language`。
- 强调类标记不因插入点展开。代码、链接、图片、行内公式在插入点进入该节点时整节点展开。

---

### Task 1: 光标在表内仍保持渲染表

**Files:**
- Create: `packages/engine/src/tables/sourceReveal.ts`
- Modify: `packages/engine/src/decorations/blocks.ts`（`case "Table"`）
- Modify: `packages/engine/src/index.ts`（`editorExtensions` 始终挂上 `tableSourceRevealed`）
- Test: `packages/engine/test/tableSourceDecorations.test.ts`

**Interfaces:**
- Consumes: `blockSelected(state, from, to)`，现有 `styleTableSource`
- Produces:
  - `revealTableSource: StateEffect<null>`
  - `tableSourceRevealed: StateField<boolean>`
  - `isTableSourceRevealed(state: EditorState): boolean`

- [ ] **Step 1: 写会失败的装饰测试**

在 `tableSourceDecorations.test.ts` 增加：选区折叠在表头单元格内部时，装饰仍是 `widget:block:table`，没有 `line:omd-table-src`。同一文档再派发 `{ selection, effects: revealTableSource.of(null) }` 后，出现三条 `line:omd-table-src`，且没有 `widget:block:table`。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @omd/engine exec vitest run test/tableSourceDecorations.test.ts`

Expected: 选区在表内的用例仍得到 `line:omd-table-src`。

- [ ] **Step 3: 实现字段并改 Table 分支**

`sourceReveal.ts`：字段默认 false；事务带 `revealTableSource` 时为 true；主选区与字段记录的表格范围不再相交时回到 false。范围存在字段值里，`revealTableSource` 的 `StateEffect` 不带位置，位置由同一事务的选区决定：选区头所在的 `Table` 节点就是被展开的表。找不到 `Table` 节点则字段保持 false。

`blocks.ts` 的 `case "Table"`：仅当 `isTableSourceRevealed(state)` 且 `blockSelected` 时调用 `styleTableSource` 并 `return true`。其余能解析出 `TableData` 的表仍发 `widget:block:table`。

`editorExtensions()` 在 `livePreviewCompartment` 之外挂 `tableSourceRevealed`，这样切到全局源码模式不会把「哪张表被展开」弄丢；全局源码模式本身没有 live 装饰，字段空转即可。

- [ ] **Step 4: 再跑该测试**

Expected: PASS。既有「源码态跳过子树、不产生 `mark:omd-strong`」用例改为先 `revealTableSource`，仍然 PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/tables/sourceReveal.ts packages/engine/src/decorations/blocks.ts packages/engine/src/index.ts packages/engine/test/tableSourceDecorations.test.ts
git commit -m "feat: keep rendered tables mounted until source is requested"
```

### Task 2: 单击单元格打开会话并画出插入点

**Files:**
- Create: `packages/engine/src/decorations/widgets/tableCellEdit.ts`
- Modify: `packages/engine/src/decorations/widgets/table.ts`（`nativePointerInteraction`、`createTableInputController`）
- Modify: `packages/engine/src/index.ts`（默认挂上 `experimentalTableDirectEdit` 那组扩展，选项 `false` 时不挂）
- Modify: `packages/engine/src/decorations/blockWidget.ts`（编辑按钮的 dispatch 能带额外 effects）
- Test: `packages/engine/test/view.test.ts`
- Test: `packages/engine/test/tableCellEdit.test.ts`

**Interfaces:**
- Consumes: `beginTableEdit`、`tableCellInputSpec`、`getTableEditSession`、`parseCell` 所用的同一 `Language`（从 `parse/cell.ts` 抽出 `cellLanguage()` 仅当现有函数是文件私有时；优先在 `tableCellEdit.ts` 用已导出的解析入口，不为导出 AST 加偏移）
- Produces:
  - `renderEditableCell(parent: HTMLElement, source: string, caret: number, options?: CellParseOptions): void`
  - `cellSourceOffsetAt(root: HTMLElement, clientX: number, clientY: number): number | null`
  - `protected editButtonEffects(): readonly StateEffect<unknown>[]`，默认空数组。`TableWidget` 返回 `[revealTableSource.of(null)]`。基类两处 `view.dispatch({ selection })` 改成带上 `effects: this.editButtonEffects()`。单元格点击不走这条 dispatch。

- [ ] **Step 1: 写会失败的视图测试**

`view.test.ts`：文档 `| 路径 |` / `| --- |` / `| \`journal/\` |`。对第二个 `td` 派发 `mousedown`（`button: 0`，target 设为该 `td`）。断言：

- `.omd-table table` 仍在
- 该 `td` 内有一个 `.omd-table-caret`
- 该 `td` 内有 `code`，其文本是 `journal/`，没有反引号字符
- `.omd-table-cell-input` 存在，且不是该 `td` 的唯一子节点
- `view.state.selection.main` 不与表格源码范围相交
- `getTableEditSession(view.state)` 的 `row === 1`、`column === 0`

`tableCellEdit.test.ts`（happy-dom，不需要 EditorView）：

- `renderEditableCell(root, "use \`code\` here", caretInsideCode)` 后，根里没有 `code` 元素，文本含反引号。
- 同一函数 `caret` 落在 `use ` 里时，有一个 `code`，文本是 `code`。
- `renderEditableCell(root, "**bold**", 3)` 后有 `strong`，文本是 `bold`，没有 `*`。
- `renderEditableCell(root, "see [a](https://e.test)", caretInsideLink)` 后文本是整段 `[a](https://e.test)`，没有 `<a>`。插入点在 `see ` 里时有一个 `a.omd-link`，文本是 `a`。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @omd/engine exec vitest run test/view.test.ts test/tableCellEdit.test.ts`

Expected: 单击单元格后表卸载，或没有 `.omd-table-caret`。`renderEditableCell` 未定义。

- [ ] **Step 3: 实现投影和点击**

`tableCellEdit.ts` 的 `renderEditableCell`：用单元格 `Language` 解析 `source`。遍历规则与规格里的两类节点一致。文本节点包一层 `<span data-from data-to>`。在 `caret` 位置插入 `<span class="omd-table-caret" aria-hidden="true">`。

`createTableInputController` 改为：清空格子后放入 `.omd-table-cell-view` 和 `input.omd-table-cell-input`。输入框宽高 1px、`opacity: 0`、绝对定位。每次 `selectionchange` 和提交后调用 `renderEditableCell`，再把输入框的 `left`/`top` 设成 `.omd-table-caret` 相对 `td` 的偏移。`input` 事件仍调用现有 `commit`。不要 `input.select()` 整格选中；焦点后把 `selectionStart` 设为点击换算的偏移，没有点击偏移时设为去掉首尾空白后的内容起点。

`cellSourceOffsetAt`：在 `root` 里用 `elementFromPoint` 找最近的 `[data-from]`，按点击位置在该节点文本中的比例映射到 `from..to`。happy-dom 没有布局时返回该节点的 `data-from`。

`index.ts`：`experimentalTableDirectEdit !== false` 时挂上现有会话扩展和 `tableDirectEditEnabled.of(true)`。默认因此打开。`TableWidget.enterSourceOnClick()` 在 `directEdit` 为真时返回 `false`，让单元格走已有的 `nativePointerInteraction`。

`nativePointerInteraction` 在打开会话前不要把文档选区派发进表格。

- [ ] **Step 4: 再跑这两个测试，并跑已有的 direct-edit 测试**

Run: `pnpm --filter @omd/engine exec vitest run test/view.test.ts test/tableCellEdit.test.ts test/tableDirectEdit.test.ts test/tableUpdateDOM.test.ts`

Expected: PASS。已有用例里「输入框是格子唯一子节点」的断言改成「格子里同时有投影和输入框」，事务断言不动。

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/decorations/widgets/tableCellEdit.ts packages/engine/src/decorations/widgets/table.ts packages/engine/src/decorations/blockWidget.ts packages/engine/src/index.ts packages/engine/test/view.test.ts packages/engine/test/tableCellEdit.test.ts packages/engine/test/tableDirectEdit.test.ts packages/engine/test/tableUpdateDOM.test.ts
git commit -m "feat: edit a rendered table cell at the caret"
```

### Task 3: 键盘走进表格时打开格子，而不是把选区放进源码

**Files:**
- Modify: `packages/engine/src/navigation/blockEntry.ts`
- Modify: `packages/engine/src/tables/directEdit.ts`（`selectionTouchesTable` 的关闭条件）
- Test: `packages/engine/test/view.test.ts`

**Interfaces:**
- Consumes: `beginTableEdit`、`tableAt`、`cellAt`（`tables/navigate.ts`）
- Produces: `enterBlock` 对 GFM `Table` widget 派发 `beginTableEdit`，选区锚点为 `table.from`。非表格块保持今天的「选区进入块、卸载 widget」。

- [ ] **Step 1: 写会失败的测试**

文档为 `before\n\n| h |\n|---|\n| x |\n\nafter`。选区在 `before` 的末尾，执行向下进入下一块的命令（`blockEntry` 导出的 keymap 对应的 ArrowDown）。断言：存在 `.omd-table-caret`，会话行号是进入方向上的第一行内容（向下为表头，行 0），`selection.main.head` 等于表格起点 `table.from`，不存在 `.omd-table-src`。

从 `after` 向上进入时，会话落在最后一行数据格。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @omd/engine exec vitest run test/view.test.ts`

Expected: 方向键把选区放进 `| h |`，表变成源码行。

- [ ] **Step 3: 实现**

`enterBlock`：目标块的语法节点名是 `Table` 且 `isTableSourceRevealed` 为假时，用 `cellAt` 取方向上的入口格，`dispatch` 的 `effects` 为 `beginTableEdit(...)`，`selection.anchor` 为 `table.from`。其它块不变。

`directEdit.ts` 的 `selectionTouchesTable`：选区锚点正好等于 `tableFrom` 时不关闭会话。选区头落在表内且本事务没有 `beginTableEdit` 时仍关闭，避免查找或拖选和格子会话并存。跟随这条关闭之后，若主选区仍是表内的折叠光标，由 `table.ts` 里已有的会话观察在下一帧调用与点击相同的打开函数，并把选区移到 `table.from`。这一跟随只在 `readOnly === false` 且没有显式源码时运行。

- [ ] **Step 4: 再跑 view 测试和 direct-edit 测试**

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/navigation/blockEntry.ts packages/engine/src/tables/directEdit.ts packages/engine/src/decorations/widgets/table.ts packages/engine/test/view.test.ts packages/engine/test/tableDirectEdit.test.ts
git commit -m "feat: enter rendered tables through the cell session"
```

### Task 4: 查看源码按钮仍能翻出整表源码

**Files:**
- Modify: `packages/engine/src/decorations/widgets/table.ts`（`editButtonEffects`）
- Test: `packages/engine/test/view.test.ts`（已有 “clicking a block widget's edit button”）

**Interfaces:**
- Consumes: `revealTableSource`、`editButtonEffects`
- Produces: 表格的 `</>` 在同一事务里展开源码并关闭格内会话（`closeTableEdit`）。

- [ ] **Step 1: 改已有按钮测试的预期并先看它失败**

该测试今天断言选区进入 `| a |` 且 widget 消失。保持这两点。追加：`isTableSourceRevealed(view.state)` 为 true；若点击前有格内会话，点击后 `getTableEditSession` 为 null。

先只改断言、不改按钮效果，跑：

Run: `pnpm --filter @omd/engine exec vitest run test/view.test.ts`

Expected: 按钮使 widget 消失，但 `isTableSourceRevealed` 为 false（Task 1 之后，仅仅把选区放进表内不再卸表，所以 widget 也会还在，测试在「widget 消失」上失败）。

- [ ] **Step 2: 按钮事务带上展开效果**

`TableWidget.editButtonEffects()` 返回 `[revealTableSource.of(null), closeTableEdit.of(null)]`。基类按钮的 dispatch 使用这个数组。点按钮前若有输入框，沿用 `clickPos` 里已有的「先 destroy 控制器再派发」顺序。

- [ ] **Step 3: 再跑 view 测试**

Expected: PASS。点按钮后是源码行；把选区移到表格下面的段落后，`.omd-table table` 回到文档里。把后面这次断言一并写进该测试。

- [ ] **Step 4: Commit**

```bash
git add packages/engine/src/decorations/widgets/table.ts packages/engine/src/decorations/blockWidget.ts packages/engine/test/view.test.ts
git commit -m "feat: reveal table source only from the source button"
```

### Task 5: 浏览器测试改成格内插入点

**Files:**
- Modify: `apps/desktop/e2e/table-navigation.spec.ts`
- Modify: `apps/desktop/e2e/table-toolbar.spec.ts`

**Interfaces:**
- Consumes: 单击后 `.omd-table table` 仍在，`.omd-table-caret` 在被点中的格子里，打字走外层事务
- Produces: 这两份规格不再把 `.omd-table-src` 当作单击的结果。源码浮层工具栏只在 `</>` 展开整表之后出现。

- [ ] **Step 1: 改导航规格的断言**

`table-navigation.spec.ts` 的 Tab 用例：单击第一个数据格后，`.omd-table table` 仍在，`.omd-table-src` 数量为 0，该格有 `.omd-table-caret`。连续 Tab 之后文档字节不变，插入点落在末格（断言末格含 `.omd-table-caret`，不再断言 `selection.main.head === DOC.indexOf("c4")`）。

打字用例：单击后表仍在。向输入框键入一个字符，文档里该格多出这个字符，撤销后字节与打开时一致。删掉「源码态表格里不该有 input」这段注释和 `.omd-table-src input` 计数。

- [ ] **Step 2: 改浮层工具栏规格**

`table-toolbar.spec.ts`：单击单元格后 `.omd-table-toolbar-floating` 不可见，渲染态 `.omd-table-toolbar` 仍在。先点 `.omd-block-edit`，再断言浮层可见且插入一行后管道行数加一。离开表格后浮层隐藏的用例改为：展开源码后再把选区派发到文末。

- [ ] **Step 3: 跑这两份规格**

Run: `PW_PORT=9431 pnpm --filter @omd/desktop exec playwright test e2e/table-navigation.spec.ts e2e/table-toolbar.spec.ts`

Expected: PASS。

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/e2e/table-navigation.spec.ts apps/desktop/e2e/table-toolbar.spec.ts
git commit -m "test: expect table clicks to keep the rendered grid"
```

### Task 6: 契约和手工验收

**Files:**
- Modify: `packages/engine/src/tables/AGENTS.md`
- Modify: `packages/engine/src/decorations/AGENTS.md`（TableWidget 一句）
- Modify: `docs/memory/gotchas-engine.md`（格内 input 那一节）
- Modify: `docs/manual-qa.md`

**Interfaces:**
- Consumes: 规格里的三态和三条验收
- Produces: 文档与代码一致。没有新的行为代码。

- [ ] **Step 1: 改三份契约**

`tables/AGENTS.md` 用规格里的三态替换 “Two states only”。写明：格内输入框是输入法锚点；`styleTableSource` 只在 `isTableSourceRevealed` 时运行，运行后仍然 `return true` 跳过子树。

`gotchas-engine.md`：删除「不要格内 input」作为生产禁令的表述。改成禁止输入框保存独立草稿或独立历史；可见格子来自 `renderEditableCell`。

`manual-qa.md` 增加三条：单击后表形不变且插入点在格内；焦点在行内代码上时只该代码露出反引号，旁边的加粗保持渲染；打一字再撤销，字节与点击前一致；`</>` 才看到管道符。

- [ ] **Step 2: 跑表格相关引擎测试**

Run: `pnpm --filter @omd/engine exec vitest run test/tableSourceDecorations.test.ts test/tableCellEdit.test.ts test/tableDirectEdit.test.ts test/tableUpdateDOM.test.ts test/view.test.ts`

Expected: PASS。

- [ ] **Step 3: Commit**

```bash
git add packages/engine/src/tables/AGENTS.md packages/engine/src/decorations/AGENTS.md docs/memory/gotchas-engine.md docs/manual-qa.md
git commit -m "docs: record rendered-table cell caret as the editing contract"
```
