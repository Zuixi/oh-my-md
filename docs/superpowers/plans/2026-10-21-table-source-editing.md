# 表格源码编辑（A）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把表格从「渲染投影 + 盖在上面的 HTML `<input>`」改成「渲染态 / 源码态二态 + 文档选区驱动」，删掉 `table.ts` 里约 321 行编辑状态机，让 undo / 查找 / 自动保存 / 崩溃恢复第一次覆盖表格输入。

**Architecture:** 光标不在表内 → 保留 `TableWidget` 渲染（含结构工具栏）；光标进表 → 不再产出块 widget，改为逐行源码装饰（等宽、表头/分隔行分类、底色），编辑能力由三个纯函数模块提供：`tables/navigate.ts`（只读查询）、`format/tableKeymap.ts`（Tab/Enter/退出，纯 `TransactionSpec`）、`tables/tools.ts`（结构操作，渲染态工具栏与源码态浮层共用）。**不新增「正在编辑哪个格」的状态** —— 该信息的唯一来源是文档选区。

**Tech Stack:** TypeScript、CodeMirror 6、Lezer Markdown、Vitest（happy-dom）、Playwright（e2e harness）、vitest bench。

**Spec:** 无独立 spec。批准的架构结论并入本文 §0（2026-10-21 评审 + 2026-10-21 自审修正）。

---

## §0 设计结论（替代 spec）

### 目标（用户可感知）

1. 点单元格不再出现单行输入框；整张表变成等宽源码网格，光标**精确落在被点的格**。
2. ⌘Z / ⌘F / 自动保存 / 崩溃恢复在表格内与正文一致（拼写检查同样一致的前提是用户已开启该设置，默认 `false`）。
3. **格间导航零重建**：Tab / Enter 只产生 selection，不改文档、不触发装饰重建。
4. 结构操作（插行/插列/删行/删列/对齐）在源码态**也可用**，入口不比今天少。
5. 有明确退出路径（`Mod-Enter`）。

### 非目标

- 不做单元格所见即所得（那是 C 方案）。
- 不重写 `parse/cell.ts`。
- 不自动改写源码字节（只有显式命令与结构操作会写）。

### 五条硬决策

| # | 决策 | 理由 |
|---|---|---|
| D1 | 表格只有「渲染态」与「源码态」，跟随选区，不引入第三态 | CM 的 `Decoration.replace` 不可分割；任何第三态都要伪造编辑面（今天约 321 行补丁的由来） |
| D2 | 「当前在哪一格」的唯一来源 = 文档选区 | 今天有 1 个状态源（`this.editing`）+ 3 套跨重建机制（`pendingTableEdits` / `pendingTableTools` / `domOwner`）；后两者语义不同，其中 `domOwner` 必须保留 |
| D3 | 只有 `td/th` 上的 mousedown 进源码；padding / 边框 / 工具栏空隙一律 `preventDefault` 后不动作 | 今天 `enterSourceOnClick() === false` 是**故意**的（"误触 wrap 整表翻源码就是表格闪烁"），不能改回 `true` |
| D4 | 源码态结构操作走 ViewPlugin 浮层，复用 `tables/tools.ts` 的纯函数 | 光标在表内时块 widget 不存在，渲染态工具栏不可达 |
| D5 | 末格 Tab 保留「追加一行」（与今天一致）；`Mod-Enter` 显式退出 | 不改已发布行为。对齐命令虽已移出，但若日后实现，必须是**显式命令、永不自动**，以保持 "preserve source text" 边界 |

### A 拍板后接受的后果（写在这里，避免被当成 bug）

1. **源码态表格内没有行内渲染**：`return true` 跳过子树后，`**粗体**`、链接、行内代码在源码态都显示为原始标记（渲染态仍然正确）。这是二态模型的必然结果。
2. **全选 / 跨块拖选语义不变**：`blockSelected` 的"完整覆盖即保持渲染"规则不动，Cmd+A 与跨表拖选仍显示渲染态 + `omd-block-covered` 覆盖层。
3. **列不对齐**：本计划不做源码列对齐（见下方"不包含"）。等宽字体只能消除字宽差异，`:---:` 与长短不一的单元格仍不会像渲染表格那样左右成列。
4. **多选区不支持表格导航**：`tableKeymap` 只处理 `selection.main`（当前未启用多光标，`clickAddsSelectionRange` 未配置）。
5. **自定义主题可能受影响**：新增 `--omd-font-family-mono` 后，代码块字体不再跟随 `--omd-font-family`。老主题若靠覆盖后者来改代码字体，需补一个 `-mono` 覆盖。

### 本计划不包含（已移出，另行处理）

| 项 | 为什么移出 |
|---|---|
| 单元格内数学渲染（KaTeX） | 与 A 无依赖，是独立 bugfix，可单独 1 天 PR 先行发布 |
| `Format table` 对齐命令 | 唯一主动改写用户源码字节的项，风险画像与 A 不同，应独立成 plan |

### Kill criteria（Task 0 结束时判定，命中任意一条即终止 A 并转 C）

1. 用 3 篇真实文档各试 30 分钟后，判定「整表变源码」的干扰 **大于** 今天的输入框干扰（3 人独立判断）。
2. 宽表（≥8 列）在源码态必须横向滚动才能看全，且占日常文档比例 > 20%。
3. 日常写作中表格编辑不是瓶颈 —— 则 A 与 C 都应让位给导出/富文本工作。

---

## Global Constraints

- 引擎不得 import React / Tauri；DOM 只允许出现在 widget / ViewPlugin（CM 视图层）里。
- 所有命令是**纯函数**：`EditorState → TransactionSpec | null`，`dispatch` 只发生在 `Command` 包装层（复用 `format/commands.ts::dispatchSpec` 的写法，含 `state.readOnly → false` 守卫）。
- 生产者不得 `forceParsing` / `ensureSyntaxTree` 到文档末尾；`tableAt` 只读 `syntaxTreeAvailable` 已覆盖的区域，未覆盖时返回 `null`。
- `Table` 源码分支**必须 `return true` 跳过子树**：否则 `inlineRules` 会在单元格里折叠 `**`、加粗文字，产出"半个预览"。
- 装饰规范：`line:omd-*` 只能由 StateField 提供；`widget:block:*` 不进原子区间。
- 结构操作的 `TableData` 必须来自**当前**语法树；`tables/edit.ts` 的每个函数都自带 `tableMatches` 校验，失败返回 `null`，调用方不得重试或猜测。
- 不改 `apps/desktop/src-tauri/**`；不改 `parse/chars.ts`。
- 测试：`pnpm test`（引擎 `tsc --noEmit` + vitest）、`pnpm --filter @omd/desktop test`、`pnpm --filter @omd/desktop build`、`pnpm --filter @omd/desktop test:e2e`、`pnpm --filter @omd/engine bench`（advisory）。
- Commit message：`<type>: <why>`，无 `Co-authored-by`（commit-msg hook 会剥离）。

---

## 任务依赖与工作量

| Task | 内容 | 依赖 | 工作日 |
|---|---|---|---|
| 0 | Spike（可丢弃） | — | 2 |
| 1 | `tables/navigate.ts` | — | 1.5 |
| 2 | Tab / Enter 导航 | 1 | 1.5 |
| 3 | 退出路径 | 2 | 1 |
| 4 | 源码网格装饰 | —（只用 `blockSelected`） | 3 |
| 5 | 点击热区与落点 | 1、4 | 1 |
| 6 | 性能基准 + IME 核对 | 5 | 0.5 |
| 7 | 源码态浮层工具栏 | 1、2 | 2 |
| 8 | 删除输入框模型（**合并门**） | 3、4、5、7 | 4 |
| 9 | e2e 重写 + 文档 | 8 | 4 |
| | **合计** | | **20.5** |

Task 1–3 可与 Task 4 并行；Task 6 与 Task 7 可并行。**Task 8 必须等 3/4/5/7 全部合并且验收通过。**

---

## 执行前置

```bash
cd /Users/wqz/Developer/my_tools/oh-my-md
git worktree add .worktrees/table-source-editing -b feat/table-source-editing origin/main
cd .worktrees/table-source-editing
pnpm install
export PW_PORT=9433   # e2e 跑独立端口，避免复用兄弟 worktree 的 Vite
```

---

## Task 0: Spike —— 验证「整表变源码」是否可接受（可丢弃）

**Files:**
- Modify（临时，不进入任何 PR）: `packages/engine/src/decorations/blocks.ts`
- Modify（临时）: `apps/desktop/src/styles.css`

**Interfaces:**
- Consumes: 无
- Produces: 一份 10 行以内的结论（Accept / Reject + 理由）。

- [ ] **Step 1: 临时把 Table 源码分支改成跳过子树**

在 `packages/engine/src/decorations/blocks.ts` 的 `case "Table":` 分支里，把

```ts
if (blockSelected(state, node.from, node.to)) return false
```

临时改成：

```ts
if (blockSelected(state, node.from, node.to)) {
  const first = state.doc.lineAt(node.from).number
  const last = state.doc.lineAt(node.to).number
  for (let n = first; n <= last; n++) {
    out.push({
      from: state.doc.line(n).from, to: state.doc.line(n).from,
      tag: "line:omd-table-src", deco: Decoration.line({ class: "omd-table-src" }),
    })
  }
  return true
}
```

- [ ] **Step 2: 临时加 4 行 CSS**

```css
.editor-host .omd-table-src {
  font-family: ui-monospace, Menlo, monospace;
  font-variant-ligatures: none;
  background: var(--omd-code-bg);
  border-left: 2px solid var(--omd-border);
}
```

- [ ] **Step 3: 跑 `pnpm dev`，用 3 篇真实文档各试 30 分钟**

必须覆盖：中文表格、≥8 列宽表、引用块内表格（`> | a |`）。

- [ ] **Step 4: 记录结论并回滚临时改动**

```bash
git checkout -- packages/engine/src/decorations/blocks.ts apps/desktop/src/styles.css
```

```text
结论：Accept / Reject
1. 中文表格观感：____
2. 宽表（≥8 列）观感：____
3. 引用内表格观感：____
4. 是否命中 Kill criteria：是/否 + 哪一条
```

- [ ] **Step 5: 命中 Kill criteria 则停止**

把结论回报给负责人，**不进入 Task 1**。

---

## Task 1: `tables/navigate.ts` —— 只读表格查询

**Files:**
- Create: `packages/engine/src/tables/navigate.ts`
- Create: `packages/engine/test/tableNavigation.test.ts`

**Interfaces:**
- Consumes: `tables/model.ts::tableDataFromNode`、`@codemirror/language` 的 `syntaxTree` / `syntaxTreeAvailable`
- Produces（Task 2/5/7 依赖，签名不可改）：

```ts
export interface TableContext {
  readonly from: number      // Table 节点绝对起点
  readonly to: number        // Table 节点绝对终点
  readonly source: string    // 文档里该表的原始切片
  readonly data: TableData
}
export interface CellSlot {
  readonly row: number       // 0 = 表头，1.. = 数据行
  readonly col: number
  readonly from: number      // 绝对偏移（cell 源码起点）
  readonly to: number        // 绝对偏移（cell 源码终点）
}
export function tableAt(state: EditorState, pos: number): TableContext | null
export function cellAt(state: EditorState, pos: number): { table: TableContext; slot: CellSlot } | null
export function nextCell(state: EditorState, pos: number, step: 1 | -1): CellSlot | null
export function cellBelow(state: EditorState, pos: number, dir: 1 | -1): CellSlot | null
```

- [ ] **Step 1: 写失败测试**

```ts
// packages/engine/test/tableNavigation.test.ts
import { describe, expect, it } from "vitest"
import { cellAt, nextCell, tableAt } from "../src/tables/navigate"
import { makeState } from "./helpers"

const DOC = ["Intro.", "", "| A | B |", "| --- | --- |", "| a | b |", "", "Outro."].join("\n")
const at = (needle: string, from = 0) => DOC.indexOf(needle, from)

describe("tableAt", () => {
  it("finds the table node and its source slice", () => {
    const state = makeState(DOC)
    const table = tableAt(state, at("a"))
    expect(table).not.toBeNull()
    expect(table!.from).toBe(DOC.indexOf("| A"))
    expect(table!.source.startsWith("| A | B |")).toBe(true)
    expect(table!.data.rows.length).toBe(1)
  })

  it("returns null outside a table", () => {
    const state = makeState(DOC)
    expect(tableAt(state, at("Intro"))).toBeNull()
  })
})

describe("cellAt", () => {
  it("maps a caret in the header to row 0", () => {
    const state = makeState(DOC)
    const hit = cellAt(state, at("A"))
    expect(hit?.slot.row).toBe(0)
    expect(hit?.slot.col).toBe(0)
  })

  it("maps a caret in a body cell to its row and column", () => {
    const state = makeState(DOC)
    const hit = cellAt(state, at("b"))
    expect(hit?.slot.row).toBe(1)
    expect(hit?.slot.col).toBe(1)
  })

  it("maps a caret on a pipe to the cell on its left", () => {
    const state = makeState(DOC)
    const hit = cellAt(state, at("|", DOC.indexOf("| a")))
    expect(hit?.slot.row).toBe(1)
    expect(hit?.slot.col).toBe(0)
  })
})

describe("nextCell", () => {
  it("walks forward across the header into the first body row", () => {
    const state = makeState(DOC)
    const next = nextCell(state, at("B"), 1)
    expect(next?.row).toBe(1)
    expect(next?.col).toBe(0)
  })

  it("walks backward from the first body cell into the header", () => {
    const state = makeState(DOC)
    const prev = nextCell(state, at("a"), -1)
    expect(prev?.row).toBe(0)
    expect(prev?.col).toBe(1)
  })

  it("returns null past the last cell", () => {
    const state = makeState(DOC)
    expect(nextCell(state, at("b"), 1)).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @omd/engine exec vitest run test/tableNavigation.test.ts`
Expected: FAIL，`Cannot find module '../src/tables/navigate'`

- [ ] **Step 3: 实现**

```ts
// packages/engine/src/tables/navigate.ts
import type { EditorState } from "@codemirror/state"
import { syntaxTree, syntaxTreeAvailable } from "@codemirror/language"
import type { SyntaxNode } from "@lezer/common"
import { tableDataFromNode, type TableData } from "./model"

export interface TableContext {
  readonly from: number
  readonly to: number
  readonly source: string
  readonly data: TableData
}

export interface CellSlot {
  readonly row: number
  readonly col: number
  readonly from: number
  readonly to: number
}

/** 只读查询：树未覆盖 pos 时返回 null（绝不推进解析）。 */
export function tableAt(state: EditorState, pos: number): TableContext | null {
  const probe = Math.min(Math.max(pos, 0), state.doc.length)
  if (!syntaxTreeAvailable(state, Math.min(probe + 1, state.doc.length))) return null
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(probe, 1)
  while (node && node.name !== "Table") node = node.parent
  if (!node) return null
  const data = tableDataFromNode(node, state)
  if (!data) return null
  return { from: node.from, to: node.to, source: state.doc.sliceString(node.from, node.to), data }
}

function slotsOf(table: TableContext): CellSlot[] {
  const out: CellSlot[] = []
  const rows = [table.data.header, ...table.data.rows]
  for (let row = 0; row < rows.length; row++) {
    const cells = rows[row].cells
    for (let col = 0; col < cells.length; col++) {
      const cell = cells[col]
      if (!cell) continue
      out.push({ row, col, from: table.from + cell.from, to: table.from + cell.to })
    }
  }
  return out
}

/** 光标所在（或正左侧）的单元格；落在管道 / 分隔行上时归左侧最近的格。 */
export function cellAt(state: EditorState, pos: number): { table: TableContext; slot: CellSlot } | null {
  const table = tableAt(state, pos)
  if (!table) return null
  const slots = slotsOf(table)
  for (const slot of slots) {
    if (pos >= slot.from && pos <= slot.to) return { table, slot }
  }
  let best: CellSlot | null = null
  for (const slot of slots) if (slot.from <= pos && (!best || slot.from > best.from)) best = slot
  return best ? { table, slot: best } : null
}

export function nextCell(state: EditorState, pos: number, step: 1 | -1): CellSlot | null {
  const hit = cellAt(state, pos)
  if (!hit) return null
  const slots = slotsOf(hit.table)
  const index = slots.findIndex(s => s.row === hit.slot.row && s.col === hit.slot.col)
  return slots[index + step] ?? null
}

/** 同列上下移动；越界返回 null（由命令层决定是否加行）。 */
export function cellBelow(state: EditorState, pos: number, dir: 1 | -1): CellSlot | null {
  const hit = cellAt(state, pos)
  if (!hit) return null
  return slotsOf(hit.table).find(s => s.row === hit.slot.row + dir && s.col === hit.slot.col) ?? null
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @omd/engine exec vitest run test/tableNavigation.test.ts`
Expected: PASS（9 个用例）

- [ ] **Step 5: 跑引擎全量，确认没有回归**

Run: `pnpm test`
Expected: 全部 PASS，`tsc --noEmit` 无错

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/tables/navigate.ts packages/engine/test/tableNavigation.test.ts
git commit -m "feat: add read-only table navigation queries"
```

---

## Task 2: Tab / Enter 单元格导航（源码态）

**Files:**
- Create: `packages/engine/src/format/tableKeymap.ts`
- Create: `packages/engine/test/tableKeymap.test.ts`
- Modify: `packages/engine/src/index.ts`（`editorExtensions` 里注册，必须排在 `codeLineKeymap` **之前**）

**Interfaces:**
- Consumes: Task 1 的 `tableAt` / `cellAt` / `nextCell` / `cellBelow` 与 `CellSlot`；`tables/edit.ts::insertTableRow`
- Produces:

```ts
export function tableNextCellSpec(state: EditorState): TransactionSpec | null
export function tablePrevCellSpec(state: EditorState): TransactionSpec | null
export function tableNextRowSpec(state: EditorState): TransactionSpec | null
export function tablePrevRowSpec(state: EditorState): TransactionSpec | null
export const tableKeymap: Extension   // Prec.highest
```

- [ ] **Step 1: 写失败测试**

```ts
// packages/engine/test/tableKeymap.test.ts
import { describe, expect, it } from "vitest"
import {
  tableNextCellSpec, tableNextRowSpec, tablePrevCellSpec,
} from "../src/format/tableKeymap"
import { makeState } from "./helpers"

const DOC = ["| A | B |", "| --- | --- |", "| a | b |", "", "after"].join("\n")

function stateAt(needle: string) {
  const base = makeState(DOC)
  return base.update({ selection: { anchor: DOC.indexOf(needle) } }).state
}

describe("tableNextCellSpec", () => {
  it("moves the caret to the next cell without touching the document", () => {
    const state = stateAt("A")
    const spec = tableNextCellSpec(state)!
    expect(spec.changes).toBeUndefined()
    const next = state.update(spec).state
    expect(next.doc.toString()).toBe(DOC)
    expect(next.selection.main.head).toBe(DOC.indexOf("B"))
  })

  it("appends a row when Tab is pressed in the last cell", () => {
    const state = stateAt("b")
    const next = state.update(tableNextCellSpec(state)!).state
    expect(next.doc.lines).toBe(DOC.split("\n").length + 1)
    const caretLine = next.doc.lineAt(next.selection.main.head)
    expect(caretLine.number).toBe(4)     // 原第 4 行是空行，新行插在表尾
    expect(caretLine.text.startsWith("|")).toBe(true)
  })

  it("returns null outside a table", () => {
    expect(tableNextCellSpec(stateAt("after"))).toBeNull()
  })
})

describe("tablePrevCellSpec", () => {
  it("moves backward", () => {
    const state = stateAt("B")
    const applied = state.update(tablePrevCellSpec(state)!).state
    expect(applied.selection.main.head).toBe(DOC.indexOf("A"))
  })

  it("returns null in the first cell (falls through)", () => {
    expect(tablePrevCellSpec(stateAt("A"))).toBeNull()
  })
})

describe("tableNextRowSpec", () => {
  it("moves to the same column in the next row", () => {
    const state = stateAt("A")
    const next = state.update(tableNextRowSpec(state)!).state
    expect(next.selection.main.head).toBe(DOC.indexOf("a"))
  })

  it("appends a row when pressed in the last row", () => {
    const state = stateAt("a")
    const next = state.update(tableNextRowSpec(state)!).state
    expect(next.doc.lines).toBe(DOC.split("\n").length + 1)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @omd/engine exec vitest run test/tableKeymap.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现**

```ts
// packages/engine/src/format/tableKeymap.ts
import { Prec, type EditorState, type TransactionSpec } from "@codemirror/state"
import { keymap, type Command } from "@codemirror/view"
import { cellAt, cellBelow, nextCell, tableAt, type CellSlot } from "../tables/navigate"
import { insertTableRow } from "../tables/edit"

function dispatchSpec(spec: (state: EditorState) => TransactionSpec | null): Command {
  return target => {
    if (target.state.readOnly) return false
    const result = spec(target.state)
    if (!result) return false
    target.dispatch(result)
    return true
  }
}

const caret = (pos: number) => ({ selection: { anchor: pos } })

/** 单元格内容起点：跳过源码前导空格（TableCell 节点可能含首空格）。 */
function contentStart(state: EditorState, slot: CellSlot): number {
  const text = state.doc.sliceString(slot.from, slot.to)
  return slot.from + (text.length - text.trimStart().length)
}

/** 在表尾追加一行，光标落到新行首格。返回 null 表示模型已失效。 */
function appendRowSpec(state: EditorState, pos: number): TransactionSpec | null {
  const table = tableAt(state, pos)
  if (!table) return null
  const change = insertTableRow(table.source, table.data, table.data.rows.length)[0]
  if (!change) return null
  // insert 形如 "\n<rowLine>"：rowLine = prefix + 可选 "|" + 两空格一组的单元格
  const neighbor = table.data.rows[table.data.rows.length - 1] ?? table.data.delimiter
  const rowLine = change.insert.replace(/^\n/, "")
  const prefixLength = neighbor.prefix.length
  const leading = rowLine.slice(prefixLength).startsWith("|") ? 1 : 0
  const rowStart = table.from + change.from + (change.insert.startsWith("\n") ? 1 : 0)
  const caretInRow = rowStart + prefixLength + leading + 1
  return {
    changes: { from: table.from + change.from, to: table.from + change.to, insert: change.insert },
    selection: { anchor: caretInRow },
  }
}

export function tableNextCellSpec(state: EditorState): TransactionSpec | null {
  const pos = state.selection.main.head
  const next = nextCell(state, pos, 1)
  if (next) return caret(contentStart(state, next))
  if (!cellAt(state, pos)) return null
  return appendRowSpec(state, pos)
}

export function tablePrevCellSpec(state: EditorState): TransactionSpec | null {
  const pos = state.selection.main.head
  const prev = nextCell(state, pos, -1)
  return prev ? caret(contentStart(state, prev)) : null
}

export function tableNextRowSpec(state: EditorState): TransactionSpec | null {
  const pos = state.selection.main.head
  const below = cellBelow(state, pos, 1)
  if (below) return caret(contentStart(state, below))
  return cellAt(state, pos) ? appendRowSpec(state, pos) : null
}

export function tablePrevRowSpec(state: EditorState): TransactionSpec | null {
  const pos = state.selection.main.head
  const above = cellBelow(state, pos, -1)
  return above ? caret(contentStart(state, above)) : null
}

// Prec.highest 且注册在 codeLine/fence/quote/list 之前：同优先级下先注册者胜。
export const tableKeymap = Prec.highest(keymap.of([
  { key: "Tab", run: dispatchSpec(tableNextCellSpec) },
  { key: "Shift-Tab", run: dispatchSpec(tablePrevCellSpec) },
  { key: "Enter", run: dispatchSpec(tableNextRowSpec) },
  { key: "Shift-Enter", run: dispatchSpec(tablePrevRowSpec) },
]))
```

> `appendRowSpec` 的光标偏移依赖 `insertTableRow` 的插入形态（`\n` + `prefix` + 可选 `|` + `BLANK_CELL` = 两空格）。若 Step 4 断言失败，**以实际 `change.insert` 为准修正偏移**，不要改成 `indexOf("|")` 模糊搜索。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @omd/engine exec vitest run test/tableKeymap.test.ts`
Expected: PASS

- [ ] **Step 5: 注册到 `editorExtensions`**

在 `packages/engine/src/index.ts` 的返回数组里，把 `tableKeymap` 放在 `codeLineKeymap` **之前**：

```ts
    tableKeymap,
    codeLineKeymap,
```

并在导出区加：

```ts
export { tableKeymap } from "./format/tableKeymap"
```

- [ ] **Step 6: 跑全量 + Commit**

```bash
pnpm test
git add packages/engine/src/format/tableKeymap.ts packages/engine/src/index.ts packages/engine/test/tableKeymap.test.ts
git commit -m "feat: navigate table cells with Tab and Enter in source mode"
```

---

## Task 3: 退出路径（`Mod-Enter`）

**Files:**
- Modify: `packages/engine/src/format/tableKeymap.ts`
- Modify: `packages/engine/test/tableKeymap.test.ts`

**Interfaces:**
- Consumes: Task 1 `tableAt`
- Produces: `exitTableSpec(state): TransactionSpec | null`

- [ ] **Step 1: 写失败测试**

```ts
import { exitTableSpec } from "../src/format/tableKeymap"

describe("exitTableSpec", () => {
  it("inserts a blank paragraph after the table and moves the caret there", () => {
    const state = stateAt("a")
    const next = state.update(exitTableSpec(state)!).state
    expect(next.doc.toString()).toContain("| a | b |\n\n")
    expect(next.doc.lineAt(next.selection.main.head).text).toBe("")
  })

  it("returns null outside a table", () => {
    expect(exitTableSpec(stateAt("after"))).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @omd/engine exec vitest run test/tableKeymap.test.ts`
Expected: FAIL，`exitTableSpec is not a function`

- [ ] **Step 3: 实现**

```ts
// 追加到 packages/engine/src/format/tableKeymap.ts
export function exitTableSpec(state: EditorState): TransactionSpec | null {
  const table = tableAt(state, state.selection.main.head)
  if (!table) return null
  const at = state.doc.length === table.to ? table.to : table.to + 1
  const insert = at >= state.doc.length ? "\n\n" : "\n"
  return {
    changes: { from: at, to: at, insert },
    selection: { anchor: at + insert.length },
  }
}
```

- [ ] **Step 4: 绑定键位**

```ts
export const tableKeymap = Prec.highest(keymap.of([
  { key: "Tab", run: dispatchSpec(tableNextCellSpec) },
  { key: "Shift-Tab", run: dispatchSpec(tablePrevCellSpec) },
  { key: "Enter", run: dispatchSpec(tableNextRowSpec) },
  { key: "Shift-Enter", run: dispatchSpec(tablePrevRowSpec) },
  { key: "Mod-Enter", run: dispatchSpec(exitTableSpec) },
]))
```

`Escape` **不绑定**：会被搜索面板/弹窗占用。

- [ ] **Step 5: 跑测试 + Commit**

```bash
pnpm test
git add -A packages/engine/src/format/tableKeymap.ts packages/engine/test/tableKeymap.test.ts
git commit -m "feat: leave a table with Mod-Enter"
```

---

## Task 4: 源码态行装饰（A0）

**Files:**
- Modify: `packages/engine/src/decorations/blocks.ts`（`case "Table":` 分支 + 新增 `styleTableSource`）
- Modify: `apps/desktop/src/styles.css`（`--omd-font-family-mono` + `.omd-table-src*`）
- Create: `packages/engine/test/tableSourceDecorations.test.ts`
- Modify: `packages/engine/test/helpers.ts`（`makeState` 增加可选 `selection` 参数）

**Interfaces:**
- Consumes: `blockSelected`（`./blockWidget`）
- Produces: 装饰 tag `line:omd-table-src`、`line:omd-table-src-head`、`line:omd-table-src-delim`

- [ ] **Step 1: 扩展测试助手**

```ts
// packages/engine/test/helpers.ts —— 签名改为：
export function makeState(
  doc: string,
  extra: Extension[] = [],
  selection?: { anchor: number; head?: number },
) {
  const state = EditorState.create({
    doc,
    selection,
    extensions: [markdownLanguageSupport(), ...extra],
  })
  // …以下保持不变
}
```

- [ ] **Step 2: 写失败测试**

```ts
// packages/engine/test/tableSourceDecorations.test.ts
import { describe, expect, it } from "vitest"
import { editorExtensions } from "../src/index"
import { livePreviewField } from "../src/decorations/build"
import { makeState } from "./helpers"

const DOC = ["| A | B |", "| --- | --- |", "| a | b |", "", "after"].join("\n")

describe("table source mode", () => {
  it("emits line decorations and no folding inside a focused table", () => {
    const state = makeState(DOC, [editorExtensions()], { anchor: DOC.indexOf("a") })
    const specs = state.field(livePreviewField).specs
    const tableFrom = DOC.indexOf("| A")
    const tableTo = DOC.indexOf("\n\nafter")
    const inside = specs.filter(s => s.from >= tableFrom && s.from <= tableTo)

    expect(inside.some(s => s.tag.startsWith("replace:"))).toBe(false)
    expect(inside.filter(s => s.tag === "line:omd-table-src").length).toBe(3)
    expect(inside.some(s => s.tag === "line:omd-table-src-head")).toBe(true)
    expect(inside.some(s => s.tag === "line:omd-table-src-delim")).toBe(true)
  })

  it("still emits the block widget when the caret is outside", () => {
    const state = makeState(DOC, [editorExtensions()], { anchor: 0 })
    const specs = state.field(livePreviewField).specs
    expect(specs.some(s => s.tag === "widget:block:table")).toBe(true)
    expect(specs.some(s => s.tag === "line:omd-table-src")).toBe(false)
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter @omd/engine exec vitest run test/tableSourceDecorations.test.ts`
Expected: FAIL（存在 `replace:` 装饰，且没有 `line:omd-table-src`）

- [ ] **Step 4: 实现 `styleTableSource` 并接入 Table 分支**

```ts
// packages/engine/src/decorations/blocks.ts —— 新增函数
function styleTableSource(
  node: { from: number; to: number },
  state: EditorState,
  out: DecoSpec[],
): void {
  const first = state.doc.lineAt(node.from).number
  const last = state.doc.lineAt(node.to).number
  for (let n = first; n <= last; n++) {
    const line = state.doc.line(n)
    out.push({
      from: line.from, to: line.from,
      tag: "line:omd-table-src",
      deco: Decoration.line({ class: "omd-table-src" }),
    })
    if (n === first) {
      out.push({
        from: line.from, to: line.from,
        tag: "line:omd-table-src-head",
        deco: Decoration.line({ class: "omd-table-src-head" }),
      })
    }
    if (n === first + 1) {
      out.push({
        from: line.from, to: line.from,
        tag: "line:omd-table-src-delim",
        deco: Decoration.line({ class: "omd-table-src-delim" }),
      })
    }
  }
}
```

```ts
// case "Table": 分支改为
    case "Table": {
      if (blockSelected(state, node.from, node.to)) {
        styleTableSource(node, state, out)
        return true   // 跳过子树：否则 inlineRules 会在单元格里折叠 ** 并加粗
      }
      const table = tableDataFromNode(node.node, state)
      // …以下保持不变
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @omd/engine exec vitest run test/tableSourceDecorations.test.ts`
Expected: PASS（2 个用例）

- [ ] **Step 6: 加 CSS**

在 `apps/desktop/src/styles.css` 的 `:root` 与 `[data-theme="dark"]` token 区各加一行：

```css
  --omd-font-family-mono: ui-monospace, Menlo, Monaco, "Cascadia Mono", Consolas, monospace;
```

在 `.editor-host .omd-table { … }` 之后追加：

```css
/* 源码态表格：等宽 + 底色 + 左边线。不用 padding（会改变行内起始位置）。 */
.editor-host .omd-table-src {
  font-family: var(--omd-font-family-mono);
  font-variant-ligatures: none;
  letter-spacing: 0;
  background: var(--omd-code-bg);
  border-left: 2px solid var(--omd-border);
}
.editor-host .omd-table-src-head { font-weight: 600; }
.editor-host .omd-table-src-delim { opacity: 0.65; }
```

- [ ] **Step 7: 跑引擎全量 + 桌面构建**

```bash
pnpm test
pnpm --filter @omd/desktop build
```

- [ ] **Step 8: Commit**

```bash
git add packages/engine/src/decorations/blocks.ts apps/desktop/src/styles.css \
        packages/engine/test/tableSourceDecorations.test.ts packages/engine/test/helpers.ts
git commit -m "feat: render focused tables as an aligned source grid"
```

---

## Task 5: 点击热区与落点（D3）

**Files:**
- Modify: `packages/engine/src/decorations/blockWidget.ts`（新增 `shouldEnterSource` 钩子）
- Modify: `packages/engine/src/decorations/widgets/table.ts`（`enterSourceOnClick`、`shouldEnterSource`、`clickPos`）
- Create: `apps/desktop/e2e/table-source.spec.ts`

**Interfaces:**
- Consumes: Task 1 `tableAt`
- Produces: `BlockWidget.shouldEnterSource(event: MouseEvent): boolean`（默认 `true`）

- [ ] **Step 1: 在基类加钩子**

```ts
// packages/engine/src/decorations/blockWidget.ts
  /** 点击是否应该让光标进入源码。默认 true；表格只在 td/th 上返回 true。 */
  protected shouldEnterSource(_event: MouseEvent): boolean { return true }
```

在 `toDOM` 的 wrap `mousedown` 监听里、`e.preventDefault()` **之前**插入：

```ts
      if (this.enterSourceOnClick() && !this.shouldEnterSource(e)) {
        // 误触点（边框/padding/工具栏空隙）：既不进源码，也不把事件交给 CM。
        e.preventDefault()
        return
      }
```

- [ ] **Step 2: 写失败的 e2e**

```ts
// apps/desktop/e2e/table-source.spec.ts
import { expect, test } from "@playwright/test"

const DOC = ["Intro.", "", "| A | B |", "| --- | --- |", "| a | b |", "", "Outro."].join("\n")

test("clicking a cell enters source at that cell; clicking padding does nothing", async ({ page }) => {
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent(DOC)}`)
  await expect(page.locator(".omd-table")).toBeVisible()

  // 点 padding（.omd-table 的 0.8em 上边距）不翻转
  await page.locator(".omd-table").click({ position: { x: 4, y: 2 } })
  await expect(page.locator(".omd-table")).toBeVisible()
  await expect(page.locator(".omd-table-src")).toHaveCount(0)

  // 点第 2 行第 2 格 → 进源码，且没有 input
  await page.locator(".omd-table tbody tr").first().locator("td").nth(1).click()
  await expect(page.locator(".omd-table-src")).toHaveCount(3)
  await expect(page.locator("input.omd-table-edit")).toHaveCount(0)

  const head = await page.evaluate(() => (window as any).__view.state.selection.main.head)
  expect(head).toBeGreaterThan(DOC.indexOf("| a | b |"))
})
```

- [ ] **Step 3: 跑 e2e 确认失败**

Run: `PW_PORT=9433 pnpm --filter @omd/desktop test:e2e -- table-source`
Expected: FAIL（点击后仍是渲染态，或出现 input）

- [ ] **Step 4: 实现 TableWidget 的三个钩子**

```ts
// packages/engine/src/decorations/widgets/table.ts
  protected enterSourceOnClick(): boolean { return true }

  protected shouldEnterSource(event: MouseEvent): boolean {
    const target = event.target
    return target instanceof Element && target.closest("td, th") !== null
  }

  protected clickPos(view: EditorView, event: MouseEvent, _wrap: HTMLElement): number {
    const cellEl = event.target instanceof Element
      ? event.target.closest<HTMLTableCellElement>("td, th")
      : null
    const table = tableAt(view.state, this.livePos())
    if (!cellEl || !table) return this.livePos()
    // rowIndex 含 thead：表头 = 0，与 CellSlot.row 同一口径。
    const rowIndex = cellEl.parentElement instanceof HTMLTableRowElement
      ? cellEl.parentElement.rowIndex
      : 0
    const slots = [table.data.header, ...table.data.rows]
    const cell = slots[rowIndex]?.cells[cellEl.cellIndex]
    if (!cell) return this.livePos()
    const leading = cell.source.length - cell.source.trimStart().length
    return table.from + cell.from + leading
  }
```

文件顶部补：

```ts
import { tableAt } from "../../tables/navigate"
```

- [ ] **Step 5: 跑 e2e 确认通过**

Run: `PW_PORT=9433 pnpm --filter @omd/desktop test:e2e -- table-source`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/decorations/blockWidget.ts \
        packages/engine/src/decorations/widgets/table.ts \
        apps/desktop/e2e/table-source.spec.ts
git commit -m "feat: enter table source only from a cell click"
```

---

## Task 6: 性能基准 + IME 核对

**Files:**
- Modify: `packages/engine/bench/measure.ts`（`measureTyping` 增加可选 `caret`）
- Modify: `packages/engine/bench/tables.bench.ts`（新增表格内打字基准）
- Modify: `docs/manual-qa.md`（新增 1 条 IME 条目）

**Interfaces:**
- Consumes: Task 5（光标进源码后，表格内打字才走 CM 热路径）
- Produces: `measureTyping(doc, { …, caret?: number })`

> **为什么需要这个任务**：A 把"在表格里打字"从**输入框内打字（零文档事务）**变成**每键一次文档事务**。这是热路径变更，必须用基准锁住，否则"格间导航零重建"成立、但"打字性能"没人管。

- [ ] **Step 1: 给 `measureTyping` 加 `caret`**

```ts
// packages/engine/bench/measure.ts
  opts: {
    keystrokes?: number
    mode?: "live" | "source"
    tree?: "steady" | "complete"
    safeWindow?: boolean
    /** 逐键起点（默认文档中点，保持既有基准不变）。 */
    caret?: number
  } = {},
) {
  // …
  let pos = opts.caret ?? Math.floor(doc.length / 2)
```

- [ ] **Step 2: 写基准**

```ts
// packages/engine/bench/tables.bench.ts —— 追加
const TABLE_TYPE_DOC = [
  "# 表格输入基准",
  "",
  "| A | B | C | D | E | F | G | H |",
  "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ...Array.from({ length: 60 }, (_, r) =>
    `| a${r} | b${r} | c${r} | d${r} | e${r} | f${r} | g${r} | h${r} |`),
  "",
].join("\n")
const TABLE_TYPE_CARET = TABLE_TYPE_DOC.indexOf("| a30 |")

describe("table typing benchmark (advisory)", () => {
  bench("typing inside a 60r x 8c table (live, steady)", () => {
    const r = measureTyping(TABLE_TYPE_DOC, {
      mode: "live", tree: "steady", keystrokes: 60, caret: TABLE_TYPE_CARET,
    })
    console.info(budgetLine("typing p95 in-table 60r x 8c live", r.p95Ms, TYPING_P95_BUDGET_MS))
  })
})
```

- [ ] **Step 3: 跑基准并记录基线**

Run: `pnpm --filter @omd/engine bench -- tables`
Expected: 打印 `typing p95 in-table …` 一行；数值与同机 `typing 10k lines (live)` 同量级（预算 16 ms，advisory 不阻断）

- [ ] **Step 4: IME 核对（不需要改代码）**

已核实：`@codemirror/view` 6.43.8 在 keymap 派发**之前**调用
`ignoreDuringComposition`（`node_modules/.pnpm/@codemirror+view@6.43.8/node_modules/@codemirror/view/dist/index.js:4553`），
组词期间的 keydown 不会进入 `tableKeymap`，且 Safari 的 compositionend→keydown 100 ms 乱序也被覆盖。
所以**不需要 `isComposing` 守卫**；只补一条手动 QA，防止未来 vendored 选择层或 keymap 层改动破坏它。

```markdown
- [ ] 中文输入法在表格单元格内组词时按 Enter 是「确认候选」，不换行、不跳格；组词结束后的 Enter 才移动
```

- [ ] **Step 5: Commit**

```bash
git add packages/engine/bench/measure.ts packages/engine/bench/tables.bench.ts docs/manual-qa.md
git commit -m "bench: measure typing inside a table after source-mode editing"
```

---

## Task 7: 源码态结构工具栏（A1b）

**Files:**
- Create: `packages/engine/src/tables/tools.ts`（纯函数，双方共用）
- Create: `packages/engine/src/tables/sourceToolbar.ts`（ViewPlugin 浮层）
- Modify: `packages/engine/src/index.ts`（装配 plugin）
- Modify: `apps/desktop/src/styles.css`（`.omd-table-toolbar-floating`）
- Create: `packages/engine/test/tableTools.test.ts`
- Create: `apps/desktop/e2e/table-toolbar.spec.ts`

**Interfaces:**
- Consumes: `tables/edit.ts` 的五个结构操作、Task 1 的 `tableAt` / `cellAt`
- Produces（Task 8 依赖）：

```ts
export type TableToolAction =
  | "insert-row" | "insert-col" | "delete-row" | "delete-col"
  | "align-left" | "align-center" | "align-right"

export function tableToolChanges(
  act: TableToolAction, source: string, table: TableData, row: number, col: number,
): readonly TableSourceChange[] | null

/** 源码态：按光标所在单元格执行。 */
export function applyTableTool(view: EditorView, act: TableToolAction): boolean

/** 共享核心：显式给出行/列（渲染态工具栏用它）。 */
export function applyTableToolAt(
  view: EditorView, from: number, source: string, table: TableData,
  row: number, col: number, act: TableToolAction,
): boolean
```

- [ ] **Step 1: 写失败测试（纯函数层）**

```ts
// packages/engine/test/tableTools.test.ts
import { describe, expect, it } from "vitest"
import { syntaxTree } from "@codemirror/language"
import { tableDataFromNode } from "../src/tables/model"
import { tableToolChanges } from "../src/tables/tools"
import { makeState } from "./helpers"

const DOC = ["| A | B |", "| --- | --- |", "| a | b |"].join("\n")

function model() {
  const state = makeState(DOC)
  const node = syntaxTree(state).topNode.firstChild!
  return { source: DOC, table: tableDataFromNode(node, state)! }
}

describe("tableToolChanges", () => {
  it("inserts a row below the given row", () => {
    const { source, table } = model()
    const changes = tableToolChanges("insert-row", source, table, 1, 0)!
    expect(changes).toHaveLength(1)
    expect(changes[0].insert).toContain("|  |")
  })

  it("refuses to delete the last remaining data row", () => {
    const { source, table } = model()
    expect(tableToolChanges("delete-row", source, table, 1, 0)).toBeNull()
  })

  it("aligns a column", () => {
    const { source, table } = model()
    const changes = tableToolChanges("align-center", source, table, 1, 1)!
    expect(changes[0].insert).toBe(":---:")
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @omd/engine exec vitest run test/tableTools.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 抽出纯函数**

```ts
// packages/engine/src/tables/tools.ts
import {
  deleteTableColumn, deleteTableRow, insertTableColumn, insertTableRow,
  setTableColumnAlignment, type TableSourceChange,
} from "./edit"
import type { TableData } from "./model"

export type TableToolAction =
  | "insert-row" | "insert-col" | "delete-row" | "delete-col"
  | "align-left" | "align-center" | "align-right"

/** row 为 0-based 行序（0 = 表头）；删除操作内部转成数据行下标。 */
export function tableToolChanges(
  act: TableToolAction,
  source: string,
  table: TableData,
  row: number,
  col: number,
): readonly TableSourceChange[] | null {
  // 插行一律"插在当前行之后"：表头行之后 = 首数据行之前。
  if (act === "insert-row") return insertTableRow(source, table, Math.min(row, table.rows.length))
  if (act === "insert-col") return insertTableColumn(source, table, col)
  if (act === "delete-row") return deleteTableRow(source, table, row - 1)
  if (act === "delete-col") return deleteTableColumn(source, table, col)
  const alignment = act === "align-left" ? "left" : act === "align-center" ? "center" : "right"
  const change = setTableColumnAlignment(source, table, col, alignment)
  return change ? [change] : null
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @omd/engine exec vitest run test/tableTools.test.ts
```

Expected: PASS

- [ ] **Step 5: 写浮层插件**

```ts
// packages/engine/src/tables/sourceToolbar.ts
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view"
import type { EditorState } from "@codemirror/state"
import { cellAt, tableAt } from "./navigate"
import { tableToolChanges, type TableToolAction } from "./tools"
import type { TableData } from "./model"
import { icon, type IconName } from "../decorations/icons"

const BUTTONS: readonly [TableToolAction, IconName, string][] = [
  ["align-left", "align-left", "Align column left"],
  ["align-center", "align-center", "Align column center"],
  ["align-right", "align-right", "Align column right"],
  ["insert-row", "row-insert-bottom", "Insert row below"],
  ["insert-col", "column-insert-right", "Insert column right"],
  ["delete-row", "row-remove", "Delete row"],
  ["delete-col", "column-remove", "Delete column"],
]

export function applyTableToolAt(
  view: EditorView,
  from: number,
  source: string,
  table: TableData,
  row: number,
  col: number,
  act: TableToolAction,
): boolean {
  if (view.state.readOnly) return false
  const changes = tableToolChanges(act, source, table, row, col)
  if (!changes) return false
  view.dispatch({
    changes: changes.map(c => ({ from: from + c.from, to: from + c.to, insert: c.insert })),
  })
  return true
}

/** 源码态：行列一律由 cellAt 解析，绝不猜。 */
export function applyTableTool(view: EditorView, act: TableToolAction): boolean {
  const hit = cellAt(view.state, view.state.selection.main.head)
  if (!hit) return false
  return applyTableToolAt(view, hit.table.from, hit.table.source, hit.table.data, hit.slot.row, hit.slot.col, act)
}

export const tableSourceToolbar = ViewPlugin.fromClass(class {
  dom: HTMLDivElement
  constructor(private view: EditorView) {
    this.dom = document.createElement("div")
    this.dom.className = "omd-table-toolbar-floating"
    this.dom.hidden = true
    for (const [act, name, title] of BUTTONS) {
      const btn = document.createElement("button")
      btn.type = "button"
      btn.dataset.act = act
      btn.appendChild(icon(name))
      btn.title = title
      btn.setAttribute("aria-label", title)
      btn.addEventListener("mousedown", e => e.preventDefault())
      btn.addEventListener("click", e => { e.preventDefault(); applyTableTool(this.view, act) })
      this.dom.appendChild(btn)
    }
    view.dom.appendChild(this.dom)
    // 构造时就定位一次：会话恢复到"光标已在表内"的场景不会等第一次 update。
    this.place(view.state)
  }
  private place(state: EditorState) {
    const table = tableAt(state, state.selection.main.head)
    if (!table || state.readOnly) { this.dom.hidden = true; return }
    // 构造期视图可能尚未完成首次测量，coordsAtPos 会抛错或返回 null —— 一律按"暂不显示"处理。
    let coords: { top: number; left: number } | null = null
    try { coords = this.view.coordsAtPos(table.from) } catch { coords = null }
    if (!coords) { this.dom.hidden = true; return }
    const host = this.view.dom.getBoundingClientRect()
    this.dom.hidden = false
    this.dom.style.top = `${coords.top - host.top - 28}px`
    this.dom.style.left = `${coords.left - host.left}px`
  }
  update(update: ViewUpdate) {
    this.place(update.state)
  }
  destroy() { this.dom.remove() }
})
```

- [ ] **Step 6: 装配 + CSS + e2e**

`index.ts` 的 `editorExtensions` 返回数组加 `tableSourceToolbar,`（放在 `livePreviewCompartment` 之后）。

`styles.css` 追加：

```css
.editor-host .omd-table-toolbar-floating {
  position: absolute; display: flex; gap: 2px; z-index: 6;
  padding: 2px; border-radius: 6px;
  background: var(--omd-chrome); border: 1px solid var(--omd-border);
}
```

```ts
// apps/desktop/e2e/table-toolbar.spec.ts
import { expect, test } from "@playwright/test"

const DOC = ["| A | B |", "| --- | --- |", "| a | b |", "", "after"].join("\n")

test("floating toolbar edits the focused table", async ({ page }) => {
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent(DOC)}`)
  await page.locator(".omd-table tbody td").first().click()
  const bar = page.locator(".omd-table-toolbar-floating")
  await expect(bar).toBeVisible()
  await bar.locator("[data-act='insert-row']").click()
  const rows = await page.evaluate(() =>
    (window as any).__view.state.doc.toString().split("\n").filter((l: string) => l.startsWith("|")).length)
  expect(rows).toBe(4) // 表头 + 分隔行 + 2 数据行
})
```

- [ ] **Step 7: 跑 e2e + 全量 + Commit**

```bash
PW_PORT=9433 pnpm --filter @omd/desktop test:e2e -- table-toolbar
pnpm test
git add -A packages/engine/src/tables packages/engine/src/index.ts \
        apps/desktop/src/styles.css apps/desktop/e2e/table-toolbar.spec.ts
git commit -m "feat: float a table toolbar over the focused table source"
```

> 若浮层在真实 WebView 滚动/缩放时抖动，**降级方案**：改为 `position: fixed` + `coordsAtPos`，只在 `viewportChanged === false` 时移动。**不接受**"去掉浮层、只留快捷键"。

---

## Task 8: 删除输入框模型（A3，**合并门**）

**Files:**
- Modify: `packages/engine/src/decorations/widgets/table.ts`（大幅删除）
- Delete: `packages/engine/test/tableInputCommit.test.ts`
- Modify: `packages/engine/test/readonly-guards.test.ts`、`view.test.ts`、`tableUpdateDOM.test.ts`、`apps/desktop/test/blockWidgetLayout.test.ts`
- Delete: `apps/desktop/e2e/table-editing.spec.ts`（由 Task 5 / 7 / 9 的新 spec 取代）

**Interfaces:**
- Consumes: Task 7 的 `applyTableToolAt`
- Produces: `TableWidget` 只剩渲染 + 工具栏 + `updateDOM` 单元格补丁

### 删除清单（按方法边界，行数为基线 815 行版本的实际值）

> 行号来自未改动的基线文件；Task 4/5/7 会改变部分行号，**执行时以方法名为准**，行号只用于核对规模。

| 方法 / 字段 | 行范围 | 行数 |
|---|---|---|
| `consumePendingEdits` / `consumePendingTool` | 442–469 | 22 |
| `bindCell`（mousedown 部分） / `clearActive` / `applyActive` | 475–502 | 26 |
| `startEdit` / `cancelEdit` | 504–576 | 72 |
| `commitPendingEdit` / `commitEdit` / `commitEditVertical` | 582–671 | 85 |
| `textNoop` / `settleTextNoop` / `neighbor` | 675–702 | 22 |
| `tool` / `deferTool` / `runPendingTool` | 724–783 | 58 |
| `pendingTableEdits` / `pendingTableTools` 声明 | 24–47 | 约 10 |
| `this.editing` 字段 + `updateDOM` 迁移块 / `ignoreEvent` 扩展 / `toDOM` 捕获监听 | 224 / 307–314 / 332–339 / 263–267 | 约 26 |

**合计约 321 行**。`tableToolChanges`（704–722，19 行）迁到 `tables/tools.ts`（Task 7 已完成）；`replace()`（793–815）保留约 10 行；`livePos()` 全部保留。

- [ ] **Step 1: 删除编辑态代码**

按上表逐项删除。**必须保留**：

```ts
- eq() / estimatedHeight
- toDOM() 的 ownDom + 工具栏监听（`</>` 的提交监听删掉：已无输入可提交）
- updateDOM()：单元格 source 变化即补丁 renderCellSlot（失焦渲染仍需要）
- renderInto()：工具栏 + thead/tbody
- livePos() / replace()（结构操作仍用它做绝对偏移换算）
- domOwner（工具栏按钮仍要按 DOM 解析当前实例）
```

**渲染态工具栏的行列来源（本任务必须补齐）**：光标在表外时 `cellAt` 不可用，
所以 `TableWidget` 在 `renderInto()` 里给每个 `td/th` 挂 `mouseover` 监听，记录
`this.row` / `this.col`（不进入源码、不改选区）。工具栏按钮改为：

```ts
btn.addEventListener("click", e => {
  e.preventDefault()
  e.stopPropagation()
  const owner = domOwner.get(el)
  if (!owner || !owner.hasRowCol()) return
  applyTableToolAt(view, owner.livePos(), owner.src, owner.table, owner.row, owner.col, act)
})
```

`hasRowCol()` 在用户尚未 hover 任何单元格时返回 `false`，按钮保持 `disabled`。

- [ ] **Step 2: 更新受影响测试**

- 删 `tableInputCommit.test.ts`；
- `readonly-guards.test.ts`：删除"单元格输入不派发"的用例，保留"结构操作在 readOnly 下被拒绝"；
- `view.test.ts` / `tableUpdateDOM.test.ts` / `blockWidgetLayout.test.ts`：凡是找 `input.omd-table-edit` 的断言，改为断言 `.omd-table-src` 或删除。

- [ ] **Step 3: 跑全量确认**

```bash
pnpm test
pnpm --filter @omd/desktop test
pnpm --filter @omd/desktop build
wc -l packages/engine/src/decorations/widgets/table.ts
```

Expected: 全绿；`table.ts` **≤ 520 行**（基线 815 − 删除约 321 + hover 跟踪约 15 ≈ 509）。

- [ ] **Step 4: 确认没有残留引用**

```bash
grep -rn "omd-table-edit\|pendingTableEdits\|pendingTableTools" packages/engine/src apps/desktop/src || true
```

Expected: 0 命中（`domOwner` 保留，不在检索范围内）。

- [ ] **Step 5: Commit**

```bash
git add -A packages/engine apps/desktop
git commit -m "refactor: drop the table cell input overlay"
```

---

## Task 9: e2e 重写 + 文档（A4）

**Files:**
- Create: `apps/desktop/e2e/table-navigation.spec.ts`
- Modify: `docs/manual-qa.md`（第 98–126 行表格段）
- Modify: `packages/engine/AGENTS.md`（表格段）
- Modify: `docs/memory/known-gotchas.md` + `docs/memory/gotchas-engine.md`

- [ ] **Step 1: 写导航 e2e**

```ts
// apps/desktop/e2e/table-navigation.spec.ts
import { expect, test } from "@playwright/test"

const ROWS = Array.from({ length: 5 }, (_, r) => `| a${r} | b${r} | c${r} |`).join("\n")
const DOC = ["| A | B | C |", "| --- | --- | --- |", ROWS, "", "after"].join("\n")

test("Tab walks every cell without touching the document", async ({ page }) => {
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent(DOC)}`)
  await page.locator(".omd-table tbody td").first().click()
  const before = await page.evaluate(() => (window as any).__view.state.doc.toString())
  // 3 列表头 + 5×3 数据格 = 18 格；从首数据格走到末格需 14 次 Tab。
  // 第 15 次会触发"末格加行"，所以这里只走 14 次。
  for (let i = 0; i < 14; i++) await page.keyboard.press("Tab")
  const after = await page.evaluate(() => (window as any).__view.state.doc.toString())
  expect(after).toBe(before)
  await expect(page.locator("input.omd-table-edit")).toHaveCount(0)
})

test("Enter at the last row appends a row", async ({ page }) => {
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent(DOC)}`)
  const countRows = () => page.evaluate(() =>
    (window as any).__view.state.doc.toString().split("\n").filter((l: string) => l.startsWith("|")).length)
  const before = await countRows()
  await page.locator(".omd-table tbody tr").last().locator("td").first().click()
  await page.keyboard.press("Enter")
  expect(await countRows()).toBe(before + 1)
})

test("Mod-Enter leaves the table", async ({ page }) => {
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent(DOC)}`)
  await page.locator(".omd-table tbody td").first().click()
  await page.keyboard.press("ControlOrMeta+Enter")
  const line = await page.evaluate(() => {
    const view = (window as any).__view
    return view.state.doc.lineAt(view.state.selection.main.head).text
  })
  expect(line).toBe("")
})
```

- [ ] **Step 2: 跑 e2e**

```bash
PW_PORT=9433 pnpm --filter @omd/desktop test:e2e
```

Expected: 全绿（含 Task 5 / Task 7 的 spec）

- [ ] **Step 3: 重写 manual-qa 表格段**

替换原「单击单元格就地编辑源码…」整段：

```markdown
- [ ] **表格二态**：单击单元格 → 整表变为等宽源码网格，光标落在被点的格；单击表格边框/padding/工具栏空隙 → 不翻转（不闪）
- [ ] **表格导航**：Tab/Shift-Tab 逐格前后移动、Enter/Shift-Enter 纵向移动；20×10 表格连按 Tab 走一遍不卡顿、不落错格，文档内容不变
- [ ] **表格退出**：Mod-Enter 在表后插入空段落并落光标
- [ ] **表格结构操作**：光标在表内时浮动工具栏可用；光标在表外时渲染态工具栏仍可用（未 hover 单元格时按钮禁用）
- [ ] **表格进度**：表格内的 ⌘Z 撤销上一个按键、⌘F 可搜到已提交内容、自动保存与崩溃恢复覆盖输入
- [ ] **表格 IME**：组词中按 Enter 是确认候选，不换行、不跳格
- [ ] **表格只读**：只读文档下浮动工具栏隐藏、Tab 不移动
- [ ] 已知限制：源码态单元格内无行内渲染（粗体/链接显示为原始标记）
```

- [ ] **Step 4: 重写 `packages/engine/AGENTS.md` 表格段**

把现有「TableWidget 也编辑单元格…」整段替换为：

```markdown
- 表格是**二态**（D1）：选区与 `Table` 节点不相交 → `TableWidget` 块替换渲染 + 结构工具栏；
  相交 → `styleTableSource` 产出 `line:omd-table-src*` 并 **`return true` 跳过子树**
  （跳过是强制的：否则 `inlineRules` 会在单元格里折叠 `**` 并加粗，产出"半个预览"）。
  编辑能力全部由 `tables/navigate.ts`（只读查询）、`format/tableKeymap.ts`（Tab/Enter/Mod-Enter）、
  `tables/tools.ts`（结构操作）提供；**不存在"活动单元格"状态** —— 该信息唯一来源是文档选区。
  源码态结构操作走 `tables/sourceToolbar.ts` 浮层；`domOwner` 仍负责渲染态工具栏的实例解析。
```

- [ ] **Step 5: 更新 gotchas**

`docs/memory/gotchas-engine.md`：

- 删 `Table edits are Lezer-range-based and per-view`（pending WeakMap 已不存在）
- 删 `Cell input is never silently discarded`（输入框已不存在）
- 改写 `Table cells are a single-line Markdown mini-document`（去掉 cell input / mousedown 相关句子，保留"只有 `parse/cell.ts` 解析单元格"）

新增 2 条：

```markdown
- **A focused table must skip its subtree** — `case "Table"` 在 `blockSelected` 为真时
  产出源码行装饰后必须 `return true`；`return false` 会让 `inlineRules` 在单元格里
  折叠 `**`、加粗文字，源码态变成"半个预览"。
- **Table keymap only sees non-composing keydown** — CM6 在派发 keymap 前调用
  `ignoreDuringComposition`，组词中的 Enter/Tab 不会进入 `tableKeymap`；不要因为
  "IME 会不会被抢键"再加一层 `isComposing` 守卫（重复守卫会让输入法在 Windows 上丢候选确认）。
```

同步更新 `known-gotchas.md` 索引行。

- [ ] **Step 6: 全量验证**

```bash
pnpm test
pnpm --filter @omd/desktop test
pnpm --filter @omd/desktop build
PW_PORT=9433 pnpm --filter @omd/desktop test:e2e
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

- [ ] **Step 7: Commit**

```bash
git add -A apps/desktop/e2e docs packages/engine/AGENTS.md
git commit -m "test: cover table source navigation and retire the input model docs"
```

---

## 验收矩阵

| # | 判据 | 验证方式 |
|---|---|---|
| 1 | 表格无输入框 | `grep -rn "omd-table-edit" packages apps` 为 0 |
| 2 | 格间导航不改文档 | `table-navigation.spec.ts` 第一条 |
| 3 | 边界点不翻转 | `table-source.spec.ts` |
| 4 | 源码态结构操作可用 | `table-toolbar.spec.ts` |
| 5 | 退出路径存在 | `table-navigation.spec.ts` 第三条 |
| 6 | 表格内打字 p95 ≤ 16 ms | `pnpm --filter @omd/engine bench -- tables`（advisory，同机对比） |
| 7 | `table.ts` ≤ 520 行 | `wc -l packages/engine/src/decorations/widgets/table.ts` |
| 8 | `decorations/widgets/` 总行数 −300 | 前后各跑一次 `wc -l packages/engine/src/decorations/widgets/*.ts` 求和对比 |
| 9 | 引擎 / 桌面 / e2e / Rust 全绿 | Task 9 Step 6 |
| 10 | 表格 gotcha 退役 2、改写 1、新增 2 | `grep -n "table\|cell" docs/memory/known-gotchas.md` 前后对比 |

## 回滚点

| 提交 | 可单独 revert | 说明 |
|---|---|---|
| Task 9 | ✅ | 只回滚文档与测试 |
| **Task 8** | ❌ | **合并门**。必须 3/4/5/7 全部合并且验收通过后才允许合并；回滚需 9→8 逆序 |
| Task 7 | ✅ | 浮层消失，结构操作回到仅在渲染态可用 |
| Task 6 | ✅ | 只动 bench 与文档 |
| Task 5 | ✅ | 点击热区放宽，行为回退 |
| Task 4 | ✅ | 源码态回退到"半折叠"，其余不变 |
| Task 3 / 2 / 1 | ⚠️ | **必须按 3→2→1 逆序 revert**：Task 2 在 `index.ts` 注册了 `tableKeymap` 并 import Task 1 的模块，单独 revert Task 1 会编译失败 |

## 事实核对表（每个数字回源）

| 断言 | 数值 | 出处 / 验证 |
|---|---|---|
| `table.ts` 基线行数 | 815 | `wc -l packages/engine/src/decorations/widgets/table.ts` |
| 可删除行数 | 约 321 | 上方删除清单逐段相加 |
| 删除后行数 | 约 509 | 815 − 321 + hover 跟踪约 15 |
| `table.ts` 验收阈值 | ≤ 520 | 同上；**不设 320**（320 需拆文件，总量不变） |
| 表专属 gotcha | 4 条 | `grep -n "table\|cell" docs/memory/known-gotchas.md` |
| 相邻 gotcha | 2 条 | 同上（`estimatedHeight` / `Async widgets`） |
| 状态源 | 1 状态 + 3 机制 → 1 状态 + 1 所有权表 | `this.editing` / `pendingTableEdits` / `pendingTableTools` / `domOwner` |
| IME 由 CM 处理 | `@codemirror/view` 6.43.8 `index.js:4553` | `grep -n ignoreDuringComposition node_modules/.pnpm/@codemirror+view@6.43.8/node_modules/@codemirror/view/dist/index.js` |
| 工作量 | 20.5 工作日 | 任务表求和 |

## Self-review 结论

- **覆盖**：D1 → Task 4；D2 → Task 8；D3 → Task 5；D4 → Task 7；D5 → Task 3；Kill criteria → Task 0；性能风险 → Task 6；IME 风险 → Task 6 Step 4。
- **无 placeholder**：全文无 TBD / TODO / "适当处理错误"；每个代码块自洽。
- **依赖闭合**：见"任务依赖与工作量"表；Task 8 是唯一合并门。
- **类型一致**：`TableContext` / `CellSlot` / `TableToolAction` / `applyTableToolAt` 在全部任务中签名一致。
- **已知风险与处置**（执行时按此修，不要绕过）：
  1. `appendRowSpec` 光标偏移依赖 `insertTableRow` 的插入形态；断言失败时以实际 `change.insert` 修正。
  2. `sourceToolbar` 浮层在滚动/缩放时可能抖动 → 降级为 `position: fixed`。
  3. `cellAt` 在分隔行/管道上归左侧最近的格；若 e2e 出现"点 A 落到别的格"，优先检查 `contentStart` 的前导空格计算。
