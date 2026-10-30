import { isolateHistory, redo, undo } from "@codemirror/commands"
import { Facet, type EditorState } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import {
  beginTableEdit,
  closeTableEdit,
  getTableEditSession,
  setTableComposition,
  tableCellInputSpec,
} from "../../tables/directEdit"
import type { CellParseOptions } from "../../parse/cell"
import type { TableAlignment, TableCellData, TableData } from "../../tables/model"
import { nextCell, tableAt, type TableContext } from "../../tables/navigate"
import { applyTableToolAt } from "../../tables/sourceToolbar"
import { TABLE_TOOL_BUTTONS } from "../../tables/tools"
import { BlockWidget, applyBlockEmbed, type BlockEmbed } from "../blockWidget"
import { registerBlockWidget, unregisterBlockWidget } from "../blockSelectionOverlay"
import { estimateTableHeightPx } from "../widgetHeights"
import { icon } from "../icons"
// cell 的 DOM 投影独立成文件（table.ts 已到增长上限）：这里只保留兼容再导出，
// 既有调用方（tables.test.ts 等）继续从 table.ts 取 renderTableCellContent。
import { renderTableCellContent, type ResolveSrc } from "./tableCell"

export { renderTableCellContent }
export type { ResolveSrc }

/** 表格外的引用定义解析器（来自 EditorState 的 reference context，见 blocks.ts）。 */
export type ResolveReference = CellParseOptions["resolveReference"]

/**
 * 渲染输入 → 结构键（表头/表体每个单元格的 source + 行列数 + 对齐）。
 * 旧实现是 `JSON.stringify(table)`：装饰重建（选区在表格附近移动也会重建 specs）
 * 每次都做整表序列化和转义。这里按 source 直接拼接，覆盖同样的渲染输入但不做转义；
 * 调用点还改成惰性求值 —— eq 先比 src，提交热路径 src 必变，结构键整段跳过。
 * `null`（ragged 行缺失源码槽）与空 source 是两种不同渲染，用独立标记区分。
 */
export function tableEqualityKey(table: TableData): string {
  const parts: string[] = []
  const encode = (cells: readonly (TableCellData | null)[]) =>
    cells.map(cell => (cell === null ? "\u0002" : cell.source)).join("\u0000")
  parts.push(encode(table.header.cells))
  for (const row of table.rows) parts.push(encode(row.cells))
  parts.push(table.aligns.join(","))
  return parts.join("\u0001")
}

/**
 * DOM 事件监听器是旧实例在 toDOM/renderInto 里挂上的，而 CM 的 pass-1 复用会保留新实例：
 * `docview.ts findWidget` → `widget.updateDOM(tile.dom, view, tile.widget)` 成功后
 * `return new WidgetTile(tile.dom, length, widget, flags)` —— DOM 和它的监听器仍属于旧
 * 实例，tile.widget 却换成了新实例（实例轮换，见 engine AGENTS 7a / math widget 先例）。
 * 所以监听器一律按 DOM 容器解析"当前 owner"，绝不闭包 this。
 * 键含两个元素：widget 根 wrap（toDOM/updateDOM 的 dom）与 renderInto 收到的
 * `.omd-block-body`（单元格和工具栏监听器都挂在 body 子树里）。
 */
const domOwner = new WeakMap<HTMLElement, TableWidget>()

const TABLE_INPUT_CLASS = "omd-table-cell-input"
const TABLE_INPUT_EVENT_TYPES = new Set([
  "keydown", "keyup", "keypress", "beforeinput", "input", "click",
  "compositionstart", "compositionupdate", "compositionend",
])

interface TableInputController {
  readonly input: HTMLInputElement
  readonly host: HTMLElement
  readonly row: number
  readonly column: number
  composing: boolean
  /** True while `commit()` dispatches its own table input transaction. */
  committing: boolean
  /** Session revision this controller last saw; a mismatch means history moved the doc. */
  revision: number
  destroy(): void
}

const tableInputControllers = new WeakMap<HTMLElement, TableInputController>()
const viewInputControllers = new WeakMap<EditorView, TableInputController>()
let tableInputControllerCount = 0

export function activeTableInputControllerCountForTest(): number {
  return tableInputControllerCount
}

function tableCellElements(body: HTMLElement): HTMLElement[][] {
  const head = Array.from(body.querySelectorAll<HTMLElement>("thead th"))
  const rows = Array.from(body.querySelectorAll<HTMLElement>("tbody tr"))
    .map(tr => Array.from(tr.children) as HTMLElement[])
  return head.length > 0 ? [head, ...rows] : rows
}

function tableCellDataRows(table: TableData): readonly (readonly (TableCellData | null)[])[] {
  return [table.header.cells, ...table.rows.map(row => row.cells)]
}

function restoreTableCell(host: HTMLElement, row: number, column: number): void {
  const owner = domOwner.get(host)
  const el = tableCellElements(host)[row]?.[column]
  if (!owner || !el) return
  renderCellSlot(
    el,
    tableCellDataRows(owner.table)[row]?.[column] ?? null,
    owner.resolveSrc,
    owner.resolveReference,
  )
}

function activeCellStart(state: EditorState, row: number, column: number): number | null {
  const session = getTableEditSession(state)
  if (!session) return null
  const table = tableAt(state, session.target.tableFrom)
  if (!table) return null
  const cell = tableCellDataRows(table.data)[row]?.[column]
  return cell ? table.from + cell.from : null
}

function createTableInputController(
  view: EditorView,
  host: HTMLElement,
  cellEl: HTMLElement,
  row: number,
  column: number,
  source: string,
): TableInputController {
  const input = document.createElement("input")
  input.type = "text"
  input.className = TABLE_INPUT_CLASS
  input.value = source
  let destroyed = false

  const commit = (value: string, kind: "typing" | "composition") => {
    const spec = tableCellInputSpec(view.state, value, kind)
    if (!spec) return
    // 本次 dispatch 内部会同步跑 updateDOM，而版本推进属于 directEdit 的事务：此时控制器
    // 版本还没变。用本地显式守卫标记"正在派发自己的事务"，让 updateDOM 跳过解析值回写
    // （解析值会 trim，会把用户刚打的尾空格擦掉）；dispatch 之后（含异常退出）再按真实
    // EditorState 校正版本。
    controller.committing = true
    try {
      view.dispatch(spec)
    } finally {
      controller.committing = false
      const session = getTableEditSession(view.state)
      if (session) controller.revision = session.revision
    }
  }

  const close = () => {
    if (destroyed) return
    view.dispatch({ effects: closeTableEdit(), annotations: isolateHistory.of("after") })
    controller.destroy()
    restoreTableCell(host, row, column)
  }

  const moveToAdjacentCell = (step: 1 | -1) => {
    const pos = activeCellStart(view.state, row, column)
    if (pos === null) return
    const slot = nextCell(view.state, pos, step)
    if (!slot) return
    const table = tableAt(view.state, slot.from)
    if (table) activateTableCellInput(view, host, slot.row, slot.col, table)
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter") {
      event.preventDefault()
      view.dispatch({ annotations: isolateHistory.of("after") })
      return
    }
    if (event.key === "Tab") {
      event.preventDefault()
      moveToAdjacentCell(event.shiftKey ? -1 : 1)
      // 末格 Tab / 首格 Shift-Tab 没有相邻格可去，仍须结束当前历史组。
      view.dispatch({ annotations: isolateHistory.of("after") })
      return
    }
    if (event.key === "Escape") {
      event.preventDefault()
      close()
      return
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
      event.preventDefault()
      if (event.shiftKey) redo(view)
      else undo(view)
    }
  }

  const onInput = (event: Event) => {
    const detail = event as InputEvent
    if (detail.isComposing || detail.inputType === "insertCompositionText") return
    commit(input.value, "typing")
  }

  const onCompositionStart = () => {
    controller.composing = true
    view.dispatch({ effects: setTableComposition(true) })
  }

  const onCompositionEnd = () => {
    controller.composing = false
    commit(input.value, "composition")
    view.dispatch({ effects: setTableComposition(false) })
  }

  const onFocusOut = () => {
    if (destroyed) return
    close()
  }

  const controller: TableInputController = {
    input,
    host,
    row,
    column,
    composing: false,
    committing: false,
    revision: 0,
    destroy() {
      if (destroyed) return
      destroyed = true
      tableInputControllerCount--
      input.removeEventListener("keydown", onKeyDown)
      input.removeEventListener("input", onInput)
      input.removeEventListener("compositionstart", onCompositionStart)
      input.removeEventListener("compositionend", onCompositionEnd)
      input.removeEventListener("focusout", onFocusOut)
      if (tableInputControllers.get(host) === controller) tableInputControllers.delete(host)
      if (viewInputControllers.get(view) === controller) viewInputControllers.delete(view)
      input.remove()
    },
  }

  input.addEventListener("keydown", onKeyDown)
  input.addEventListener("input", onInput)
  input.addEventListener("compositionstart", onCompositionStart)
  input.addEventListener("compositionend", onCompositionEnd)
  input.addEventListener("focusout", onFocusOut)
  tableInputControllerCount++
  tableInputControllers.set(host, controller)
  viewInputControllers.set(view, controller)
  cellEl.replaceChildren(input)
  return controller
}

function activateTableCellInput(
  view: EditorView,
  host: HTMLElement,
  row: number,
  column: number,
  table: TableContext,
): void {
  if (view.state.readOnly) return
  const cell = tableCellDataRows(table.data)[row]?.[column]
  const cellEl = tableCellElements(host)[row]?.[column]
  if (!cell || !cellEl) return
  const existing = viewInputControllers.get(view) ?? tableInputControllers.get(host)
  if (existing && existing.host === host && existing.row === row && existing.column === column) {
    existing.input.focus()
    existing.input.select()
    return
  }
  if (existing) {
    existing.destroy()
    restoreTableCell(existing.host, existing.row, existing.column)
  }
  view.dispatch({
    effects: beginTableEdit({
      tableFrom: table.from,
      tableTo: table.to,
      row,
      column,
      source: table.source,
    }),
  })
  const controller = createTableInputController(view, host, cellEl, row, column, cell.source)
  controller.revision = getTableEditSession(view.state)?.revision ?? 0
  controller.input.focus()
  controller.input.select()
}

export const tableDirectEditEnabled = Facet.define<boolean, boolean>({
  combine: values => values.some(Boolean),
})

function ownDom(widget: TableWidget, dom: HTMLElement): void {
  domOwner.set(dom, widget)
  const body = dom.querySelector<HTMLElement>(".omd-block-body")
  if (body) domOwner.set(body, widget)
}

function releaseDom(widget: TableWidget, dom: HTMLElement): void {
  if (domOwner.get(dom) === widget) domOwner.delete(dom)
  const body = dom.querySelector<HTMLElement>(".omd-block-body")
  if (body && domOwner.get(body) === widget) domOwner.delete(body)
}

/** 结构未变才能走 updateDOM 原地补丁；行列数变化一律返回 false 交给 toDOM 全量重建。 */
function sameTableShape(a: TableData, b: TableData): boolean {
  return a.header.cells.length === b.header.cells.length
    && a.rows.length === b.rows.length
    && a.aligns.length === b.aligns.length
    && a.rows.every((row, index) => row.cells.length === b.rows[index].cells.length)
}

/** 单个单元格槽位的完整视觉状态（内容 + ragged 缺失槽语义），renderInto 与 updateDOM 共用。 */
function renderCellSlot(
  el: HTMLElement,
  cell: TableCellData | null,
  resolveSrc?: ResolveSrc,
  resolveReference?: ResolveReference,
): void {
  el.replaceChildren()
  if (cell === null) {
    // ragged 行缺失源码槽的视觉填充：语义标识为不可用（没有源码可改）。
    el.classList.add("omd-table-cell-missing")
    el.setAttribute("aria-disabled", "true")
    el.title = MISSING_CELL_TITLE
    return
  }
  el.classList.remove("omd-table-cell-missing")
  el.removeAttribute("aria-disabled")
  el.removeAttribute("title")
  // 表格层已经吃掉 `\|` 的屏蔽反斜杠，cell 源是 GFM 表格语义；定义来自表格外。
  renderTableCellContent(el, cell.text, resolveSrc, { pipeEscapes: "gfm-table", resolveReference })
}

/** 对齐按钮的 active 高亮必须跟着目标列的对齐方式走（渲染态与原地补丁态共用）。 */
function applyAlignActive(toolbar: HTMLElement, currentAlign: TableAlignment): void {
  for (const act of ["align-left", "align-center", "align-right"] as const) {
    const btn = toolbar.querySelector<HTMLElement>(`[data-act='${act}']`)
    if (btn) btn.classList.toggle("omd-table-tool-active", act === `align-${currentAlign}`)
  }
}

/** 合成缺失单元格（ragged 行的视觉填充）的语义标注。 */
const MISSING_CELL_TITLE = "Missing source cell; add a column or edit Markdown source"

/**
 * 表格的**渲染态**：光标在表外时的投影 + 结构工具栏。
 *
 * 表格只有两个状态（见 plan D1/D2）：光标进表即整表变源码网格（`omd-table-src`
 * 行装饰），本 widget 连同其工具栏一起卸载。所以这里**没有**编辑态、没有输入框、
 * 也不持有"正在编辑哪一格"——渲染态唯一需要知道的行/列来自鼠标 hover，
 * 只为让工具栏按钮有明确目标。
 */
export class TableWidget extends BlockWidget {
  readonly table: TableData
  private view: EditorView | undefined
  private wrap: HTMLDivElement | undefined
  /** 工具栏目标格的行列（行序与源码槽一致：0 = 表头，1 = 首数据行）。 */
  private row = 0
  private col = 0
  /** 用户是否 hover 过某个 td/th：没 hover 就没有目标，工具栏按钮保持 disabled。 */
  private hovered = false
  private equalityKeyCache: string | undefined

  constructor(
    src: string,
    pos: number,
    table: TableData,
    embed?: BlockEmbed,
    readonly resolveSrc?: ResolveSrc,
    readonly directEdit = false,
    readonly resolveReference?: ResolveReference,
  ) {
    super(src, pos, embed)
    this.table = table
  }

  cellDataAt(row: number, column: number): TableCellData | null {
    return tableCellDataRows(this.table)[row]?.[column] ?? null
  }

  private get equalityKey(): string {
    return (this.equalityKeyCache ??= tableEqualityKey(this.table))
  }

  eq(other: TableWidget) {
    // resolveSrc 不参与相等性：由宿主 facet 注入，只在编辑器配置重建时变化。
    // 引用解析器**必须**参与：引用定义增删改只换 resolver 身份，src 一字不变。
    // 先比 src/embed（提交热路径必变，直接短路），相同才比较结构键。
    return super.eq(other)
      && this.equalityKey === other.equalityKey
      && this.resolveReference === other.resolveReference
  }

  // 滚动性能：整表一个块，缺省按一行行高估算会让视口换算严重过绘（见
  // widgetHeights.ts 头注）。换行感知估算（按各格文本长度），首绘后 CM 用
  // 实测高度替换。
  override get estimatedHeight() {
    return estimateTableHeightPx(this.table)
  }

  override toDOM(view: EditorView) {
    this.view = view
    this.wrap = super.toDOM(view)
    ownDom(this, this.wrap)
    return this.wrap
  }

  // pass 1 原地刷新（仅 eq 失败才到这里）：CM 复用旧实例建的 DOM 与监听器，却把
  // tile.widget 换成这个新实例。这里把 DOM 重新认领为新实例的当前状态，只补丁变化的
  // 单元格 —— 表格渲染不再整块重建（无闪烁、O(变化格)）。
  // 结构变化（行列数）返回 false 让 CM 走 toDOM 全量重建：结构性操作本就低频。
  override updateDOM(dom: HTMLElement, view: EditorView, prev: TableWidget): boolean {
    const before = prev.table
    const after = this.table
    if (!sameTableShape(before, after)) return false
    const body = dom.querySelector<HTMLElement>(".omd-block-body")
    const cells = tableCellElements(body ?? dom)
    if (cells.length === 0) return false
    // resolver 身份变了：所有非活动格的渲染输入都变了（源码没变也一样）。
    const referencesChanged = prev.resolveReference !== this.resolveReference
    const active = body ? tableInputControllers.get(body) : undefined
    const viewActive = viewInputControllers.get(view)
    this.view = view
    this.wrap = dom as HTMLDivElement
    ownDom(this, dom)

    const session = (active !== undefined || viewActive !== undefined) && view.state
      ? getTableEditSession(view.state)
      : null
    const sessionOnThisTable = session !== null
      && this.src === session.target.source
      && this.livePos() === session.target.tableFrom
    const keepInput = active !== undefined && sessionOnThisTable
      && session.target.row === active.row && session.target.column === active.column
    const moveInput = !keepInput && sessionOnThisTable && (active !== undefined || viewActive !== undefined)

    // 旧 DOM 上的嵌入类/深度属于上一个实例（CM pass-1 只换了 tile.widget）：
    // 整块刷新成当前嵌入值，深度变深/离开列表/进出引用都不会留旧状态。
    applyBlockEmbed(dom, this.embed)
    // 迁移上一实例的工具栏目标：行列不变时 hover 语义延续（没有 hover 就仍是没有）。
    this.row = prev.row
    this.col = prev.col
    this.hovered = prev.hovered

    if (active && !keepInput) {
      active.destroy()
      const el = cells[active.row]?.[active.column]
      if (el) {
        renderCellSlot(
          el, this.cellDataAt(active.row, active.column), this.resolveSrc, this.resolveReference,
        )
      }
    } else if (moveInput && viewActive && viewActive.host !== body) {
      viewActive.destroy()
      restoreTableCell(viewActive.host, viewActive.row, viewActive.column)
    }
    // 历史回放（撤销/重做）把文档换成了另一版格内容：输入框节点保持不动，内容按
    // 恢复后的格同步。用户自己输入推进的版本一致，所以不会被解析值回写。
    // 提交中的同一次 dispatch 会同步调到这里、且版本尚未推进，但那正是用户刚打的字，
    // 由控制器自身的 committing 守卫排除，不靠预测版本号。
    // 版本已变即证明文档是被历史移动的，此时必须按精确值比较：trim 比较会让
    // 只有空白的差异（`"X "` → `"X"`）漏同步，输入框停在旧内容上。
    if (keepInput && active && session && !active.committing
      && !active.composing && !session.composing) {
      const stale = session.revision !== active.revision
      active.revision = session.revision
      const source = this.cellDataAt(active.row, active.column)?.source
      if (stale && source !== undefined && active.input.value !== source) {
        active.input.value = source
      }
    }

    for (let r = 0; r < cells.length; r++) {
      const beforeRow = r === 0 ? before.header : before.rows[r - 1]
      const afterRow = r === 0 ? after.header : after.rows[r - 1]
      for (let c = 0; c < cells[r].length; c++) {
        const el = cells[r][c]
        // source 相同即同一渲染输入（text 是 source 的纯函数）；null ↔ 非 null 也在此区分。
        const keepCellInput = (keepInput && r === active.row && c === active.column)
          || (moveInput && session !== null && r === session.target.row && c === session.target.column)
        if (!keepCellInput) {
          const was = beforeRow?.cells[c] ?? null
          const now = afterRow?.cells[c] ?? null
          if (referencesChanged || was?.source !== now?.source) {
            renderCellSlot(el, now, this.resolveSrc, this.resolveReference)
          }
        }
        const align = after.aligns[c] ?? ""
        if (align) el.style.textAlign = align
        else el.style.removeProperty("text-align")
      }
    }
    if (moveInput && body && session) {
      const targetEl = cells[session.target.row]?.[session.target.column]
      const targetCell = this.cellDataAt(session.target.row, session.target.column)
      if (targetEl && targetCell) {
        const moved = createTableInputController(
          view,
          body,
          targetEl,
          session.target.row,
          session.target.column,
          targetCell.source,
        )
        moved.revision = session.revision
        moved.input.focus()
        moved.input.select()
      }
    }
    const toolbar = dom.querySelector<HTMLElement>(".omd-table-toolbar")
    if (toolbar) this.syncToolbar(toolbar)

    registerBlockWidget(this, dom)
    if (prev !== this) unregisterBlockWidget(prev)
    return true
  }

  override destroy(dom?: HTMLElement) {
    const host = (dom ?? this.currentDom)?.querySelector<HTMLElement>(".omd-block-body")
    if (host) tableInputControllers.get(host)?.destroy()
    if (dom) releaseDom(this, dom)
    super.destroy(dom)
  }

  override ignoreEvent(event: Event) {
    if (TABLE_INPUT_EVENT_TYPES.has(event.type)) {
      const target = event.target
      const input = target instanceof Element ? target.closest(`.${TABLE_INPUT_CLASS}`) : null
      const host = input?.closest(".omd-block-body")
      if (input && host instanceof HTMLElement
        && tableInputControllers.get(host)?.input === input) return true
    }
    return super.ignoreEvent(event)
  }

  protected nativePointerInteraction(event: MouseEvent): boolean {
    if (!this.directEdit) return false
    const target = event.target
    if (!(target instanceof Element)) return false
    if (target.closest(`.${TABLE_INPUT_CLASS}`)) return true
    const cellEl = target.closest<HTMLTableCellElement>("td, th")
    const host = cellEl?.closest<HTMLElement>(".omd-block-body")
    const owner = host ? domOwner.get(host) : undefined
    const view = owner?.view ?? this.view
    if (!cellEl || !host || !owner || !owner.directEdit || !view) return false
    if (view.state.readOnly) return false
    const row = cellEl.parentElement instanceof HTMLTableRowElement
      ? cellEl.parentElement.rowIndex
      : 0
    const column = cellEl.cellIndex
    const table = tableAt(view.state, owner.livePos())
    if (!table || !owner.cellDataAt(row, column)) return false
    event.preventDefault()
    activateTableCellInput(view, host, row, column, table)
    return true
  }

  /** 工具栏是否有可操作的目标格（用户 hover 过某个 td/th）。 */
  hasRowCol(): boolean { return this.hovered }

  // 单元格点击是"进源码并落在该格"的意图；wrap 的 padding/边框/工具栏空隙是误触，
  // 由 shouldEnterSource 挡掉（不进源码；焦点仍进编辑器，见 blockWidget）。
  protected enterSourceOnClick(): boolean { return true }

  protected shouldEnterSource(event: MouseEvent): boolean {
    const target = event.target
    return target instanceof Element && target.closest("td, th") !== null
  }

  protected clickPos(view: EditorView, event: MouseEvent, _wrap: HTMLElement): number {
    const cellEl = event.target instanceof Element
      ? event.target.closest<HTMLTableCellElement>("td, th")
      : null
    // 无单元格命中（padding 已被 shouldEnterSource 挡掉，剩下的是 `</>` 按钮）：直接回退，
    // 不查表 —— 该路径的 view 可能来自没有真实 EditorState 的调用方。
    // 若直接编辑态输入框仍挂在当前表格里，先在进入源码事务前卸载，防止随后 view.focus()
    // 触发的同步 focusout 发送 closeTableEdit 而打断外层历史或留下瞬态残留。
    if (!cellEl) {
      const host = _wrap.querySelector<HTMLElement>(".omd-block-body")
      const active = host ? tableInputControllers.get(host) : undefined
      if (active) {
        active.destroy()
        restoreTableCell(active.host, active.row, active.column)
      }
      return this.livePos()
    }
    const table = tableAt(view.state, this.livePos())
    if (!table) return this.livePos()
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

  protected get cssClass() { return "omd-table" }

  /**
   * 工具栏按钮的可用性：只读、尚未 hover 到任何格、以及单行/单列的结构删除都禁用，
   * 顺带把当前列的对齐方式高亮到对齐按钮上。
   */
  private syncToolbar(toolbar: HTMLElement): void {
    const readonly = this.view?.state?.readOnly ?? false
    // 仅剩一行/一列时结构性删除无效：按当前模型禁用对应按钮。
    const canDeleteRow = this.table.rows.length > 1
    const canDeleteCol = this.table.header.cells.length > 1
    for (const btn of toolbar.querySelectorAll<HTMLButtonElement>("button")) {
      const act = btn.dataset.act
      btn.disabled = readonly
        || !this.hovered
        || (act === "delete-row" && !canDeleteRow)
        || (act === "delete-col" && !canDeleteCol)
    }
    applyAlignActive(toolbar, this.table.aligns[this.col] ?? "")
  }

  protected renderInto(el: HTMLElement) {
    // 渲染态结构工具栏。readOnly 建档时固定、widget 生命周期内无翻转路径，因此
    // disabled 只在 syncToolbar 里按当前状态重算；applyTableToolAt 的 readOnly 守卫
    // 仍是权威防线（disabled 只挡用户交互，程序化 click 仍会到达）。
    const toolbar = document.createElement("div")
    toolbar.className = "omd-table-toolbar"
    for (const [act, iconName, title] of TABLE_TOOL_BUTTONS) {
      const btn = document.createElement("button")
      btn.type = "button"
      btn.dataset.act = act
      btn.appendChild(icon(iconName))
      btn.title = title
      btn.setAttribute("aria-label", title)
      btn.tabIndex = -1
      btn.addEventListener("mousedown", e => {
        e.preventDefault()
        e.stopPropagation()
      })
      btn.addEventListener("click", e => {
        e.preventDefault()
        e.stopPropagation()
        // 实例轮换后工具栏按钮仍绑在旧实例上：按 wrap 取当前 owner。
        const owner = domOwner.get(el)
        if (!owner || !owner.hasRowCol()) return
        const view = owner.view
        if (!view) return
        // 直接编辑态输入框处于输入法合成中时，未提交的草稿只存在于 DOM input 中；
        // 若先关闭控制器，外层结构操作将用旧源码覆盖草稿。反之非合成态下先优雅关闭
        // 控制器并还原单元格，再执行整表结构重写，保证会话与 DOM 干净结束。
        const active = tableInputControllers.get(el)
        if (active?.composing) return
        if (active) {
          view.dispatch({ effects: closeTableEdit(), annotations: isolateHistory.of("after") })
          active.destroy()
          restoreTableCell(active.host, active.row, active.column)
        }
        // 行列来自 hover；偏移与源码一律由 applyTableToolAt 校验，陈旧输入直接拒绝。
        applyTableToolAt(view, owner.livePos(), owner.src, owner.table, owner.row, owner.col, act)
      })
      toolbar.appendChild(btn)
    }
    // 未 hover 任何格：按钮全部 disabled，点击也不会到 applyTableToolAt。
    this.syncToolbar(toolbar)
    el.appendChild(toolbar)

    const table = document.createElement("table")
    const thead = document.createElement("thead")
    const hr = document.createElement("tr")
    for (const [i, c] of this.table.header.cells.entries()) {
      const th = document.createElement("th")
      renderCellSlot(th, c ?? null, this.resolveSrc, this.resolveReference)
      if (this.table.aligns[i]) th.style.textAlign = this.table.aligns[i]
      if (c) this.bindCellHover(el, th, 0, i)
      hr.appendChild(th)
    }
    thead.appendChild(hr)
    table.appendChild(thead)
    const tbody = document.createElement("tbody")
    for (const [r, row] of this.table.rows.entries()) {
      const tr = document.createElement("tr")
      for (let i = 0; i < this.table.header.cells.length; i++) {
        const cell = row.cells[i]
        const td = document.createElement("td")
        renderCellSlot(td, cell ?? null, this.resolveSrc, this.resolveReference)
        if (this.table.aligns[i]) td.style.textAlign = this.table.aligns[i]
        // ragged 行的合成占位格没有源码槽：不参与工具栏目标（点它无事可做）。
        if (cell) this.bindCellHover(el, td, r + 1, i)
        tr.appendChild(td)
      }
      tbody.appendChild(tr)
    }
    table.appendChild(tbody)
    el.appendChild(table)
  }

  /**
   * 渲染态工具栏的落点来源：hover 只记录行列，不翻源码、不改选区（翻源码只由
   * mousedown 触发的 shouldEnterSource/clickPos 决定）。
   * 结构操作会改变行列数 → `updateDOM` 返回 false、CM 全量重建 → hover 目标清空：
   * 旧下标在新形状里已经指向别处，宁可要求重新 hover 也不猜。
   */
  private bindCellHover(wrap: HTMLElement, el: HTMLElement, row: number, col: number) {
    el.addEventListener("mouseover", () => {
      // 监听器闭包的是建 DOM 的那个实例；CM pass-1 复用后 owner 已轮换成新实例
      // （见 domOwner 注释），所以每次事件都按 wrap 解析当前 owner。
      const owner = domOwner.get(wrap)
      if (!owner) return
      // mouseover 在她同一格内部的子元素上也会冒泡：目标格没变就别重算工具栏。
      if (owner.hovered && owner.row === row && owner.col === col) return
      owner.row = row
      owner.col = col
      owner.hovered = true
      const toolbar = wrap.querySelector<HTMLElement>(".omd-table-toolbar")
      if (toolbar) owner.syncToolbar(toolbar)
    })
  }

  private livePos() {
    if (this.view && this.wrap) {
      try { return this.view.posAtDOM(this.wrap) }
      catch { /* widget detached */ }
    }
    return this.pos
  }
}
