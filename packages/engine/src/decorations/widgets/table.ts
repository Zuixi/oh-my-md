import { EditorView } from "@codemirror/view"
import { parseCell, type CellNode } from "../../parse/cell"
import {
  deleteTableColumn,
  deleteTableRow,
  insertTableColumn,
  insertTableRow,
  replaceTableCell,
  type TableSourceChange,
} from "../../tables/edit"
import type { TableData } from "../../tables/model"
import { BlockWidget, type BlockEmbed } from "../blockWidget"

interface PendingTableEdit {
  readonly pos: number
  readonly row: number
  readonly col: number
}

const pendingTableEdits = new WeakMap<EditorView, PendingTableEdit>()

type TableToolAction = "insert-row" | "insert-col" | "delete-row" | "delete-col"

const pendingTableTools = new WeakMap<
  EditorView,
  { readonly pos: number; readonly act: TableToolAction; readonly row: number; readonly col: number }
>()

function changesNonOverlapping(changes: readonly TableSourceChange[]): boolean {
  // changes 已按 from 升序；相邻区间不允许重叠（零宽插入允许贴边）。
  for (let index = 1; index < changes.length; index++) {
    if (changes[index].from < changes[index - 1].to) return false
  }
  return true
}

function reportViewError(view: EditorView, error: unknown): void {
  for (const report of view.state.facet(EditorView.exceptionSink)) report(error)
}

type ResolveSrc = (src: string) => string

export function tableEqualityKey(table: TableData): string {
  return JSON.stringify(table)
}

function renderCellContainer(
  parent: HTMLElement,
  tag: string,
  children: CellNode[],
  resolveSrc?: ResolveSrc,
): void {
  const el = document.createElement(tag)
  for (const child of children) renderCellNode(el, child, resolveSrc)
  parent.appendChild(el)
}

function renderCellNode(parent: HTMLElement, node: CellNode, resolveSrc?: ResolveSrc): void {
  switch (node.type) {
    case "text": parent.appendChild(document.createTextNode(node.text)); return
    case "code": {
      const el = document.createElement("code")
      el.textContent = node.text
      parent.appendChild(el)
      return
    }
    case "math": {
      const el = document.createElement("code")
      el.className = "omd-cell-math"
      el.textContent = node.text
      parent.appendChild(el)
      return
    }
    case "em": renderCellContainer(parent, "em", node.children, resolveSrc); return
    case "strong": renderCellContainer(parent, "strong", node.children, resolveSrc); return
    case "del": renderCellContainer(parent, "del", node.children, resolveSrc); return
    case "mark": renderCellContainer(parent, "mark", node.children, resolveSrc); return
    case "underline": renderCellContainer(parent, "u", node.children, resolveSrc); return
    case "link": {
      const a = document.createElement("a")
      a.href = node.href
      a.target = "_blank"
      a.rel = "noopener noreferrer"
      a.className = "omd-link"
      for (const child of node.children) renderCellNode(a, child, resolveSrc)
      parent.appendChild(a)
      return
    }
    case "image": {
      const img = document.createElement("img")
      img.src = resolveSrc ? resolveSrc(node.src) : node.src
      img.alt = node.alt
      img.className = "omd-image"
      img.onerror = () => {
        img.replaceWith(Object.assign(document.createElement("span"), {
          className: "omd-image-broken",
          textContent: node.src,
        }))
      }
      parent.appendChild(img)
      return
    }
    case "br": parent.appendChild(document.createElement("br")); return
    case "hr": parent.appendChild(document.createElement("hr")); return
    case "ul": renderCellContainer(parent, "ul", node.children, resolveSrc); return
    case "ol": renderCellContainer(parent, "ol", node.children, resolveSrc); return
    case "li": renderCellContainer(parent, "li", node.children, resolveSrc); return
    case "blockquote": renderCellContainer(parent, "blockquote", node.children, resolveSrc); return
    case "pre": {
      const pre = document.createElement("pre")
      const code = document.createElement("code")
      code.textContent = node.text
      pre.appendChild(code)
      parent.appendChild(pre)
      return
    }
  }
}

// cell 内容按引擎自有的 markdown parser 解析后再渲染（任意语法：粗体/斜体/删除线/
// 高亮/下划线/行内代码/行内数学/链接/autolink/图片/emoji/HTML 实体/`<br>`/列表/引用/
// 代码块/分隔线），不再是手写正则。
export function renderTableCellContent(parent: HTMLElement, text: string, resolveSrc?: ResolveSrc): void {
  for (const node of parseCell(text)) renderCellNode(parent, node, resolveSrc)
}

/** 合成缺失单元格（ragged 行的视觉填充）的语义标注。 */
const MISSING_CELL_TITLE = "Missing source cell; add a column or edit Markdown source"

export class TableWidget extends BlockWidget {
  readonly table: TableData
  private view: EditorView | undefined
  private wrap: HTMLDivElement | undefined
  private row = 0
  private col = 0
  private editing: { el: HTMLElement; row: number; col: number } | null = null
  private cells: HTMLElement[][] = []
  private readonly equalityKey: string

  constructor(
    src: string,
    pos: number,
    table: TableData,
    embed?: BlockEmbed,
    readonly resolveSrc?: ResolveSrc,
  ) {
    super(src, pos, embed)
    this.table = table
    this.equalityKey = tableEqualityKey(table)
  }

  eq(other: TableWidget) {
    // resolveSrc 不参与相等性：由宿主 facet 注入，只在编辑器配置重建时变化。
    return super.eq(other) && this.equalityKey === other.equalityKey
  }

  override toDOM(view: EditorView) {
    this.view = view
    this.wrap = super.toDOM(view)
    return this.wrap
  }

  override ignoreEvent(event: Event) {
    return super.ignoreEvent(event)
      || event.type === "keydown"
      || event.type === "keyup"
      || event.type === "keypress"
      || event.type === "input"
      || event.type === "click"
  }

  protected get cssClass() { return "omd-table" }

  protected renderInto(el: HTMLElement) {
    // 只读档（HUGE Live 预览）禁用表格编辑 affordance；readOnly 建档时固定，
    // widget 生命周期内无翻转路径。replace() 的 dispatch 守卫仍是权威防线。
    const readonly = this.view?.state.readOnly ?? false
    // 仅剩一行/一列时结构性删除无效：工具栏按当前模型禁用对应按钮，
    // 用户在编辑状态下点 disabled 控件不会落入「先提交、后 no-op」路径。
    const canDeleteRow = this.table.rows.length > 1
    const canDeleteCol = this.table.header.cells.length > 1
    const toolbar = document.createElement("div")
    toolbar.className = "omd-table-toolbar"
    for (const [act, label, title] of [
      ["insert-row", "+row", "Insert row below"],
      ["insert-col", "+col", "Insert column right"],
      ["delete-row", "−row", "Delete row"],
      ["delete-col", "−col", "Delete column"],
    ] as const) {
      const btn = document.createElement("button")
      btn.type = "button"
      btn.dataset.act = act
      btn.textContent = label
      btn.title = title
      btn.tabIndex = -1
      btn.disabled = readonly
        || (act === "delete-row" && !canDeleteRow)
        || (act === "delete-col" && !canDeleteCol)
      btn.addEventListener("mousedown", e => {
        e.preventDefault()
        e.stopPropagation()
      })
      btn.addEventListener("click", e => {
        e.preventDefault()
        e.stopPropagation()
        this.tool(act)
      })
      toolbar.appendChild(btn)
    }
    el.appendChild(toolbar)

    this.cells = []
    const table = document.createElement("table")
    const thead = document.createElement("thead")
    const hr = document.createElement("tr")
    const head: HTMLElement[] = []
    for (const [i, c] of this.table.header.cells.entries()) {
      const th = document.createElement("th")
      renderTableCellContent(th, c?.text ?? "", this.resolveSrc)
      if (this.table.aligns[i]) th.style.textAlign = this.table.aligns[i]
      this.bindCell(th, 0, i)
      head.push(th)
      hr.appendChild(th)
    }
    this.cells.push(head)
    thead.appendChild(hr)
    table.appendChild(thead)
    const tbody = document.createElement("tbody")
    for (const [r, row] of this.table.rows.entries()) {
      const tr = document.createElement("tr")
      const line: HTMLElement[] = []
      for (let i = 0; i < this.table.header.cells.length; i++) {
        const cell = row.cells[i]
        const td = document.createElement("td")
        renderTableCellContent(td, cell?.text ?? "", this.resolveSrc)
        // ragged 行缺失源码槽的视觉填充：语义标识为不可用，不能打开输入框
        // （没有可写源码范围，输入也无法提交）。
        if (!cell) {
          td.className = "omd-table-cell-missing"
          td.setAttribute("aria-disabled", "true")
          td.title = MISSING_CELL_TITLE
        }
        if (this.table.aligns[i]) td.style.textAlign = this.table.aligns[i]
        this.bindCell(td, r + 1, i)
        line.push(td)
        tr.appendChild(td)
      }
      this.cells.push(line)
      tbody.appendChild(tr)
    }
    table.appendChild(tbody)
    el.appendChild(table)

    const pending = this.view && pendingTableEdits.get(this.view)
    if (pending && pending.pos === this.livePos()) {
      pendingTableEdits.delete(this.view!)
      const cell = this.cells[pending.row]?.[pending.col]
      if (cell && this.cellData(pending.row, pending.col)) {
        queueMicrotask(() => {
          if (cell.isConnected) this.startEdit(cell, pending.row, pending.col)
        })
      }
    }

    // 两阶段工具栏操作（删除 active 行/列与单元格提交重叠时）：单元格已先提交，
    // 重建后的本表在此消费 pending，在微任务里对 fresh Lezer 元数据派发结构操作。
    // Consume before scheduling：删除 entry 后再排微任务，任何后续失败都不会留下
    // 可被其他表/视图消费的残留；位置不匹配（不同表/不同位置）则不触碰 entry。
    const pendingTool = this.view && pendingTableTools.get(this.view)
    if (pendingTool && pendingTool.pos === this.livePos()) {
      pendingTableTools.delete(this.view!)
      const { act, row, col } = pendingTool
      queueMicrotask(() => {
        try {
          this.runPendingTool(act, row, col)
        } catch (error) {
          if (this.view) reportViewError(this.view, error)
        }
      })
    }
  }

  private cellData(row: number, col: number) {
    return row === 0 ? this.table.header.cells[col] : this.table.rows[row - 1]?.cells[col]
  }

  private bindCell(el: HTMLElement, row: number, col: number) {
    el.addEventListener("mousedown", e => {
      e.preventDefault()
      e.stopPropagation()
      if (e.target instanceof HTMLInputElement) return
      if (!this.cellData(row, col)) return
      this.row = row
      this.col = col
      this.startEdit(el, row, col)
    })
  }

  private clearActive() {
    for (const line of this.cells) {
      for (const el of line) {
        el.classList.remove("omd-table-row-active")
        el.classList.remove("omd-table-col-active")
      }
    }
  }

  private applyActive(row: number, col: number) {
    this.cells[row]?.forEach(el => el.classList.add("omd-table-row-active"))
    for (const line of this.cells) line[col]?.classList.add("omd-table-col-active")
  }

  private startEdit(el: HTMLElement, row: number, col: number) {
    // 只读档不开行内编辑器（开了也无法提交 —— replace() 会拒绝 dispatch）。
    // 防御所有入口（点击与重建后的键盘续编）：合成 ragged cell 没有可写源码范围。
    if (this.view?.state.readOnly || !this.cellData(row, col)) return
    if (this.editing?.el === el) return
    this.cancelEdit()
    this.row = row
    this.col = col
    this.clearActive()
    this.applyActive(row, col)
    const input = document.createElement("input")
    input.type = "text"
    input.className = "omd-table-edit"
    input.value = this.cellData(row, col)?.source ?? ""
    el.replaceChildren(input)
    this.editing = { el, row, col }
    input.addEventListener("mousedown", e => {
      e.stopPropagation()
    })
    input.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault()
        const tab = e.key === "Tab"
        const shiftTab = tab && e.shiftKey
        this.commitEdit(shiftTab ? -1 : 1, shiftTab ? "shift-tab" : tab ? "tab" : "enter")
      } else if (e.key === "Escape") {
        e.preventDefault()
        this.cancelEdit()
      }
    })
    input.focus()
    const caret = input.value.length
    input.setSelectionRange(caret, caret)
  }

  private cancelEdit() {
    const edit = this.editing
    if (!edit) return
    this.editing = null
    this.clearActive()
    edit.el.replaceChildren()
    renderTableCellContent(edit.el, this.cellData(edit.row, edit.col)?.text ?? "", this.resolveSrc)
  }

  private commitEdit(move: 1 | -1 | 0, fromKey?: "tab" | "shift-tab" | "enter") {
    const edit = this.editing
    const input = edit?.el.querySelector("input.omd-table-edit") as HTMLInputElement | null
    if (!edit || !input) return
    const cell = this.cellData(edit.row, edit.col)
    if (!cell) return
    const change = replaceTableCell(this.src, cell, input.value)
    if (!change) return
    this.editing = null
    this.clearActive()
    const neighbor = move === 0 ? null : this.neighbor(edit.row, edit.col, move)
    let dest = neighbor && this.cellData(neighbor.row, neighbor.col) ? neighbor : null
    let changes: TableSourceChange[] = [change]

    // 末格 Tab：同一事务提交当前单元格并在表尾追加一个空行，重建后聚焦新行首格
    // （oldRowCount + 1 行、0 列）。只有按键是 Tab 才插行 —— Enter 在末格只提交、
    // 不扩展行；Shift-Tab 在首格只提交、不开表外输入框。绝不凭 move 推断插行意图。
    if (!neighbor && move === 1 && fromKey === "tab") {
      const inserted = insertTableRow(this.src, this.table, this.table.rows.length)
      if (inserted && changesNonOverlapping([change, ...inserted])) {
        changes = [...changes, ...inserted].sort((a, b) => a.from - b.from)
        dest = { row: this.table.rows.length + 1, col: 0 }
      }
    }
    this.replace(changes, dest)
  }

  private neighbor(row: number, col: number, dir: 1 | -1) {
    const cols = this.table.header.cells.length
    const rows = this.table.rows.length + 1
    const i = row * cols + col + dir
    if (i < 0 || i >= rows * cols) return null
    return { row: Math.floor(i / cols), col: i % cols }
  }

  private tableToolChanges(act: TableToolAction, row: number, col: number) {
    return act === "insert-row" ? insertTableRow(this.src, this.table, row)
      : act === "insert-col" ? insertTableColumn(this.src, this.table, col)
      : act === "delete-row" ? deleteTableRow(this.src, this.table, row - 1)
      : deleteTableColumn(this.src, this.table, col)
  }

  private tool(act: TableToolAction) {
    // 只读守卫（replace() 是最终权威，此处提前拒绝主路径）。
    if (this.view?.state.readOnly) return
    const edit = this.editing
    const input = edit?.el.querySelector("input.omd-table-edit") as HTMLInputElement | null
    let committed: TableSourceChange | null = null
    if (edit && input) {
      const cell = this.cellData(edit.row, edit.col)
      committed = cell ? replaceTableCell(this.src, cell, input.value) : null
      // 陈旧元数据导致提交失败：保持输入框挂载，不静默销毁用户文本。
      if (!committed) return
      const isNoop = committed.insert === this.src.slice(committed.from, committed.to)
      if (!isNoop) {
        if (act === "insert-row" || act === "insert-col") {
          const inserted =
            act === "insert-row"
              ? insertTableRow(this.src, this.table, this.row)
              : insertTableColumn(this.src, this.table, this.col)
          // 结构插入被拒绝（越界/陈旧）→ 保留输入框。
          if (!inserted) return
          // 单元格提交与结构 change 互不重叠时合并为一个排序、非重叠事务。
          const merged = [committed, ...inserted].sort((a, b) => a.from - b.from)
          if (changesNonOverlapping(merged)) {
            this.editing = null
            this.replace(merged)
            return
          }
          // 意外重叠：退化为两阶段（与删除路径一致）。
        }
        // 删除 active 行/列必然覆盖正编辑的单元格：先提交单元格，重建后补结构操作。
        this.deferTool(act, committed, edit)
        return
      }
      // 输入值未变（no-op 提交）：等效于“无编辑”。保持 this.editing 不动，
      // 单事务结构操作失败（next === null）时输入框继续挂载。
    }
    // `this.row` 是 1-based（0=表头，1=首数据行），tableToolChanges 映射到
    // deleteTableRow 的 0-based 数据行索引；表头映射到 -1，自然成为 no-op。
    const next = this.tableToolChanges(act, this.row, this.col)
    if (!next) return
    this.editing = null
    this.replace(next)
  }

  private deferTool(act: TableToolAction, committed: TableSourceChange, edit: { el: HTMLElement; row: number; col: number }) {
    this.editing = null
    const pos = this.livePos()
    pendingTableTools.set(this.view!, { pos, act, row: edit.row, col: edit.col })
    // 只派发单元格提交；结构操作等重建后的本表消费 pending 再补做。
    this.replace([committed])
  }

  private runPendingTool(act: TableToolAction, row: number, col: number) {
    // 检测 widget 已断开（销毁/切源码）：pending 已被消费，直接放弃补派发。
    if (!this.view || !this.wrap?.isConnected) return
    // 对重建后的 fresh Lezer 元数据（this.src/this.table）执行结构操作。
    const next = this.tableToolChanges(act, row, col)
    if (!next) return  // 目标缺失或操作被拒绝 → 不再派发。
    this.replace(next)
  }

  private livePos() {
    if (this.view && this.wrap) {
      try { return this.view.posAtDOM(this.wrap) }
      catch { /* widget detached */ }
    }
    return this.pos
  }

  private replace(changes: readonly TableSourceChange[], dest: { row: number; col: number } | null = null) {
    // 权威只读守卫：commitEdit/tool 的所有源码改写都汇入此处。readOnly 是建议性
    // facet，widget 直 dispatch 绕过输入拦截 —— 只读档不派发（也不设置 pending edit，
    // 微任务渲染恢复路径不会误开编辑器）。disabled 按钮只挡用户交互，程序化
    // click 仍可到达 tool()，故此处必须显式拒绝。
    if (changes.length === 0 || !this.view || this.view.state.readOnly) return
    const pos = this.livePos()
    if (dest) pendingTableEdits.set(this.view, { pos, row: dest.row, col: dest.col })
    const translated = changes.map(change => ({
      from: pos + change.from,
      to: pos + change.to,
      insert: change.insert,
    }))
    try {
      this.view.dispatch({ changes: translated.length === 1 ? translated[0] : translated })
    } catch (error) {
      // 派发失败：清除本视图所有 pending（键盘续编与两阶段工具），不让其泄漏。
      if (dest) pendingTableEdits.delete(this.view)
      pendingTableTools.delete(this.view)
      throw error
    }
  }
}
