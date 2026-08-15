import type { EditorView } from "@codemirror/view"
import { parseCell, type CellNode } from "../../parse/cell"
import {
  deleteTableColumn,
  deleteTableRow,
  insertTableColumn,
  insertTableRow,
  replaceTableCell,
} from "../../tables/edit"
import { BlockWidget, type BlockEmbed } from "../blockWidget"

let resumeEdit: { pos: number; row: number; col: number } | null = null

export type TableAlignment = "left" | "center" | "right" | ""

export interface TableData {
  header: string[]
  rows: string[][]
  aligns: TableAlignment[]
}

type ResolveSrc = (src: string) => string

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

export class TableWidget extends BlockWidget {
  private view: EditorView | undefined
  private row = 0
  private col = 0
  private editing: { el: HTMLElement; row: number; col: number } | null = null
  private cells: HTMLElement[][] = []

  constructor(
    src: string,
    pos: number,
    readonly table: TableData,
    embed?: BlockEmbed,
    readonly resolveSrc?: ResolveSrc,
  ) {
    super(src, pos, embed)
  }

  eq(other: TableWidget) {
    // resolveSrc 不参与相等性：由宿主 facet 注入，只在编辑器配置重建时变化。
    return super.eq(other) && JSON.stringify(this.table) === JSON.stringify(other.table)
  }

  override toDOM(view: EditorView) {
    this.view = view
    return super.toDOM(view)
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
    for (const [i, c] of this.table.header.entries()) {
      const th = document.createElement("th")
      renderTableCellContent(th, c, this.resolveSrc)
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
      for (let i = 0; i < this.table.header.length; i++) {
        const td = document.createElement("td")
        renderTableCellContent(td, row[i] ?? "", this.resolveSrc)
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

    if (resumeEdit && resumeEdit.pos === this.pos) {
      const { row, col } = resumeEdit
      resumeEdit = null
      const cell = this.cells[row]?.[col]
      if (cell) this.startEdit(cell, row, col)
    }
  }

  private cellSource(row: number, col: number) {
    return row === 0 ? (this.table.header[col] ?? "") : (this.table.rows[row - 1]?.[col] ?? "")
  }

  private bindCell(el: HTMLElement, row: number, col: number) {
    el.addEventListener("mousedown", e => {
      e.preventDefault()
      e.stopPropagation()
      if (e.target instanceof HTMLInputElement) return
      this.row = row
      this.col = col
      this.startEdit(el, row, col)
    })
  }

  private startEdit(el: HTMLElement, row: number, col: number) {
    if (this.editing?.el === el) return
    this.cancelEdit()
    this.row = row
    this.col = col
    const input = document.createElement("input")
    input.type = "text"
    input.className = "omd-table-edit"
    input.value = this.cellSource(row, col)
    el.replaceChildren(input)
    this.editing = { el, row, col }
    input.addEventListener("mousedown", e => {
      e.stopPropagation()
    })
    input.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault()
        this.commitEdit(e.key === "Tab" && e.shiftKey ? -1 : 1)
      } else if (e.key === "Escape") {
        e.preventDefault()
        this.cancelEdit()
      }
    })
    input.focus()
    input.select()
  }

  private cancelEdit() {
    const edit = this.editing
    if (!edit) return
    this.editing = null
    edit.el.replaceChildren()
    renderTableCellContent(edit.el, this.cellSource(edit.row, edit.col), this.resolveSrc)
  }

  private commitEdit(move: 1 | -1 | 0) {
    const edit = this.editing
    const input = edit?.el.querySelector("input.omd-table-edit") as HTMLInputElement | null
    if (!edit || !input) return
    const next = replaceTableCell(this.src, edit.row, edit.col, input.value)
    if (!next) return
    this.editing = null
    const dest = move === 0 ? null : this.neighbor(edit.row, edit.col, move)
    this.replace(next, dest)
    if (next && dest && this.cells[dest.row]?.[dest.col])
      this.startEdit(this.cells[dest.row][dest.col], dest.row, dest.col)
  }

  private neighbor(row: number, col: number, dir: 1 | -1) {
    const cols = this.table.header.length
    const rows = this.table.rows.length + 1
    const i = row * cols + col + dir
    if (i < 0 || i >= rows * cols) return null
    return { row: Math.floor(i / cols), col: i % cols }
  }

  private tool(act: "insert-row" | "insert-col" | "delete-row" | "delete-col") {
    let src = this.src
    const edit = this.editing
    const input = edit?.el.querySelector("input.omd-table-edit") as HTMLInputElement | null
    if (edit && input) {
      const committed = replaceTableCell(src, edit.row, edit.col, input.value)
      if (committed) src = committed
      this.editing = null
    }
    const next = act === "insert-row" ? insertTableRow(src, this.row)
      : act === "insert-col" ? insertTableColumn(src, this.col)
      : act === "delete-row" ? deleteTableRow(src, this.row)
      : deleteTableColumn(src, this.col)
    this.replace(next)
  }

  private replace(next: string | null, dest: { row: number; col: number } | null = null) {
    if (!next || !this.view) return
    if (dest) resumeEdit = { pos: this.pos, row: dest.row, col: dest.col }
    this.view.dispatch({
      changes: { from: this.pos, to: this.pos + this.src.length, insert: next },
    })
  }
}
