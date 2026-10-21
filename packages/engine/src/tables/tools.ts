import {
  deleteTableColumn,
  deleteTableRow,
  insertTableColumn,
  insertTableRow,
  setTableColumnAlignment,
  type TableSourceChange,
} from "./edit"
import type { TableData } from "./model"

// 表格结构工具栏的 action 词汇表。源码态浮层（tables/sourceToolbar.ts）与渲染态
// 工具栏（decorations/widgets/table.ts）共用同一套名词，避免两个工具栏对同一动作
// 各写一份源码改写逻辑（此前渲染态把映射逻辑内嵌在 widget 私有方法里）。
export type TableToolAction =
  | "insert-row"
  | "insert-col"
  | "delete-row"
  | "delete-col"
  | "align-left"
  | "align-center"
  | "align-right"

/** row 为 0-based 行序（0 = 表头）；删除操作内部转成数据行下标。 */
export function tableToolChanges(
  act: TableToolAction,
  source: string,
  table: TableData,
  row: number,
  col: number,
): readonly TableSourceChange[] | null {
  // 插行一律"插在当前行之后"：表头行之后 = 首数据行之前。row 越界时夹到表尾，
  // 由 insertTableRow 自己校验 afterRow 边界（表头 → 0 = 首数据行之前）。
  if (act === "insert-row") return insertTableRow(source, table, Math.min(row, table.rows.length))
  if (act === "insert-col") return insertTableColumn(source, table, col)
  // 表头（row 0）映射到 -1，被 deleteTableRow 的边界检查自然拒绝。
  if (act === "delete-row") return deleteTableRow(source, table, row - 1)
  if (act === "delete-col") return deleteTableColumn(source, table, col)
  const alignment = act === "align-left" ? "left" : act === "align-center" ? "center" : "right"
  const change = setTableColumnAlignment(source, table, col, alignment)
  return change ? [change] : null
}
