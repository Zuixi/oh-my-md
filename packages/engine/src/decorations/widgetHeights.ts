// 块 widget 高度估算（滚动性能）。CodeMirror 对 estimatedHeight 缺省（-1）的
// 块 widget 按**一行行高**估算高度（@codemirror/view HeightMapper.point：
// height < 0 → oracle.lineHeight）：表格/代码块这类实际占数百像素、数十源码行
// 的块被估成 ~26px。视口（可见区 ± 1000px）按估算像素换算字符范围时严重
// 过绘 —— 一帧内同时 toDOM 多个重块；画完实测高度修正又触发高度图回环与
// 内容总高跳变。这是大文档（数百 KB、大量表格）滚轮滚动卡顿的主因之一
// （上游同类：codemirror/CodeMirror#5873、discuss.codemirror.net/t/9372）。
//
// 这里按内容规模线性外推估算，只需量级正确（±2x）：首次绘制后 CM 会用实测
// 高度替换估算，估算仅影响「从未画过/滚出视口销毁后再滚入」的首次布局。
//
// 常量按默认排版标定（.cm-content 16px / line-height 1.6 ≈ 25.6px 行高，
// 样式出处 apps/desktop/src/styles.css 的 .omd-table/.omd-code 等）。用户
// 字体设置会整体缩放实际高度，估算同比例失真 —— 相对「一行行高」的缺省仍
// 好一个数量级。新增块 widget 时在此登记估算，勿在 widget 内散落裸字面量。
//
// 实测标定（2026-09-10，真实 Chromium 1200px 视口，apps/desktop/e2e/
// calibrate-heights.mjs）：20 行×4 列（单行单元格）表格 wrap 总高 906.7px vs
// 估算 908px（0.15%）；30 行代码块 689.7px vs 估算 686px（0.5%）。多行换行
// 单元格由下方换行感知公式覆盖（真实 5 列文档固定 42px/行曾低估全文 8.4%），
// 首绘实测后校正 —— 复用 spec 身份（build.ts）保证校正只发生一次而不振荡。

import type { TableCellData, TableData } from "../tables/model"

// 表格单行基础高度：th/td padding 8px×2 + 边框 ~2px ≈ 18px（不含文本行）。
export const TABLE_ROW_BASE_PX = 18
// 表格文本行高（0.93em × line-height 1.6 @16px ≈ 24px）。
export const TABLE_TEXT_LINE_PX = 24
// .omd-table wrap 上下 padding 0.8em×2（盖过 .omd-block 的 0.5em）。
export const TABLE_BLOCK_CHROME_PX = 26
// 换行感知标定（2026-09-10 实测偏差驱动）：真实「大量表格」文档的单元格文本
// 20–40 字，5 列下普遍 2–3 行换行，固定 42px/行低估全文总高 8.4%（thumb 对齐
// 失真的直接来源）。列宽按标称内容宽（CONTENT_MAX_WIDTH 900 − padding/边框）
// 均摊，每格按 CJK≈15px / ASCII≈8px 字宽估换行数，行高取该行各格最大值。
// 更窄的编辑器窗口会放大换行（残余低估方向），由首绘实测校正。
const TABLE_CONTENT_WIDTH_PX = 850
const TABLE_CJK_CHAR_PX = 15
const TABLE_ASCII_CHAR_PX = 8
// td min-width（styles.css）；窄表列均摊后不足此值按此兜底。
const TABLE_MIN_COL_PX = 90
// 列宽松弛：table-layout:auto 会把更多宽度分给长文本列，均摊假设偏窄、
// 换行数偏多（整表高估 ~3%）。实测调参（2026-09-10 两份 5 列真实文档：
// 8.4% 低估 → +2.5~3.2% 高估 → 加松弛后收敛）。
const TABLE_COL_WIDTH_SLACK = 1.1
// 每格换行数外推上限：极端长文本不再外推（防单格撑爆估算），漏掉的行数由
// 首绘实测校正。
const TABLE_CELL_MAX_LINES = 6

// 代码块内容行（pre：0.9em × line-height 1.45）。
export const CODE_LINE_ESTIMATE_PX = 21
// header（标题输入行 + padding）+ pre 上下 padding + 边框。
export const CODE_BLOCK_CHROME_PX = 56
// 编辑态 chrome widget（替换围栏行：标题输入行高于普通文本行）。
export const CODE_CHROME_ESTIMATE_PX = 44

// KaTeX display 数学块：典型 2 行文本 + 上下 margin。
export const MATH_BLOCK_ESTIMATE_PX = 58
// Mermaid：异步渲染，SVG 高度差异极大；取中小图的中位量级，实测后由 CM 修正。
export const MERMAID_ESTIMATE_PX = 200
// front matter：渲染为单个 chip 行（0.8em + padding + 块 padding），与源码行数无关。
export const FRONT_MATTER_ESTIMATE_PX = 38
// 水平分割线：hr 上下 margin 0.5em + 边框 ≈ 1.3 行。
export const HR_ESTIMATE_PX = 34

/** 代码块估算高度：内容行 × 行高 + chrome。 */
export function estimateCodeBlockHeightPx(lines: number): number {
  return CODE_BLOCK_CHROME_PX + Math.max(1, lines) * CODE_LINE_ESTIMATE_PX
}

/** 源码行数（按 \n 计；空串为 0）。 */
export function countSourceLines(src: string): number {
  return src.length === 0 ? 0 : src.split("\n").length
}

// CJK（含全宽标点）≈ 一字宽，ASCII/半角 ≈ 半字宽。
function cellTextWidthPx(text: string): number {
  let width = 0
  for (let i = 0; i < text.length; i++) {
    width += text.charCodeAt(i) > 0x2e80 ? TABLE_CJK_CHAR_PX : TABLE_ASCII_CHAR_PX
  }
  return width
}

// 行高 = 该行各格换行数的最大值 × 文本行高 + 行基础高度。
function estimateTableRowPx(cells: readonly (TableCellData | null)[], colPx: number): number {
  let lines = 1
  for (const cell of cells) {
    if (!cell) continue
    const cellLines = Math.min(
      TABLE_CELL_MAX_LINES,
      Math.ceil(cellTextWidthPx(cell.text) / colPx),
    )
    if (cellLines > lines) lines = cellLines
  }
  return lines * TABLE_TEXT_LINE_PX + TABLE_ROW_BASE_PX
}

/** 表格估算高度（换行感知）：表头 + 数据行按各格文本长度估换行行数，
 * 行高取行内最大；列宽按标称内容宽均摊（min-width 兜底）。 */
export function estimateTableHeightPx(table: TableData): number {
  const cols = Math.max(1, table.header.cells.length)
  const colPx = Math.max(TABLE_MIN_COL_PX, ((TABLE_CONTENT_WIDTH_PX - cols) / cols) * TABLE_COL_WIDTH_SLACK)
  let height = TABLE_BLOCK_CHROME_PX + estimateTableRowPx(table.header.cells, colPx)
  for (const row of table.rows) {
    height += estimateTableRowPx(row.cells, colPx)
  }
  return height
}
