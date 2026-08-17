# 15 Table Editing

**日期：** 2026-08-16  
**状态：** 已确认  
**差距分析：** `docs/superpowers/specs/2026-08-16-industry-gap-analysis.md`  
**父设计：** `docs/superpowers/specs/2026-08-10-oh-my-md-design.md`

## 目标

Live Preview 下表格可就地改单元格，并可增删行列，不必整表退回源码。

## 非目标

- 不实现拖拽调列宽、合并单元格、Excel 粘贴智能分列。
- 不在表格内再嵌套可编辑块 widget。
- 单元格内 Markdown 仍按现有 `parseCell` 只读渲染；编辑时显示源码文本。
- 不改 GFM 表格解析器。

## 当前证据

- `packages/engine/src/decorations/widgets/table.ts`：`TableWidget` 渲染 HTML table。
- 选区进入表格源码范围时 widget 卸下，露出 pipe 源码。
- 无单元格写入 API。

## 用户流程

1. 光标不在表内时表格保持预览。
2. 单击单元格：该格变成单行 input，值为单元格源码；提交后写回对应 pipe 单元格。
3. Enter / Tab 提交并移到下一格；Shift-Tab 上一格；Escape 取消。
4. 预览表右上角提供：在下方插入行、在右侧插入列、删除当前行、删除当前列。至少剩 1 行 1 列。
5. 写回必须保留对齐分隔行（`:---` 等）与未改单元格原文。

## 接口

引擎纯函数（新文件 `packages/engine/src/tables/edit.ts`）：

```ts
export interface TableEdit {
  readonly from: number
  readonly to: number
  readonly insert: string
}

export function replaceTableCell(
  source: string,
  row: number,
  column: number,
  value: string,
): string | null

export function insertTableRow(source: string, afterRow: number): string | null
export function insertTableColumn(source: string, afterColumn: number): string | null
export function deleteTableRow(source: string, row: number): string | null
export function deleteTableColumn(source: string, column: number): string | null
```

`row`：`0` 是表头，`1` 起是数据行。函数吃整块表格源码（含换行），失败返回 `null`。

`TableWidget` 在单元格 `mousedown` 上 `preventDefault`，打开 input；提交时 `view.dispatch` 替换整块表格源码。对齐行不算可编辑数据行。

## 错误处理

- 畸形表：函数返回 `null`，widget 忽略点击。
- 并发编辑：以 dispatch 时的源码为准；stale widget 因 `eq` 重建。

## 测试

对 fixture 表：改头/改单元格、插入行列表、删到最小表、含 `\|` 的单元格、对齐行保持。Widget 测试：点击后出现 input，提交后文档含新文本。

## 文档

`docs/manual-qa.md` M2 表格条改为可就地编辑。
