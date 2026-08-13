import { BlockWidget } from "../blockWidget"

export type TableAlignment = "left" | "center" | "right" | ""

export interface TableData {
  header: string[]
  rows: string[][]
  aligns: TableAlignment[]
}

// ponytail: 表格单元格按纯文本渲染（block replace 内叠不了行内装饰）；
// 需要表内加粗/链接渲染时再考虑 widget 内自渲染行内子集。
export class TableWidget extends BlockWidget {
  constructor(src: string, pos: number, readonly table: TableData) {
    super(src, pos)
  }

  eq(other: TableWidget) {
    return super.eq(other) && JSON.stringify(this.table) === JSON.stringify(other.table)
  }

  protected get cssClass() { return "omd-table" }

  protected renderInto(el: HTMLElement) {
    const table = document.createElement("table")
    const thead = document.createElement("thead")
    const hr = document.createElement("tr")
    for (const [i, c] of this.table.header.entries()) {
      const th = document.createElement("th")
      th.textContent = c
      if (this.table.aligns[i]) th.style.textAlign = this.table.aligns[i]
      hr.appendChild(th)
    }
    thead.appendChild(hr)
    table.appendChild(thead)
    const tbody = document.createElement("tbody")
    for (const row of this.table.rows) {
      const tr = document.createElement("tr")
      for (let i = 0; i < this.table.header.length; i++) {
        const td = document.createElement("td")
        td.textContent = row[i] ?? ""
        if (this.table.aligns[i]) td.style.textAlign = this.table.aligns[i]
        tr.appendChild(td)
      }
      tbody.appendChild(tr)
    }
    table.appendChild(tbody)
    el.appendChild(table)
  }
}
