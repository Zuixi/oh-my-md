import { BlockWidget } from "../blockWidget"

// ponytail: 表格单元格按纯文本渲染（block replace 内叠不了行内装饰）；
// 需要表内加粗/链接渲染时再考虑 widget 内自渲染行内子集。
export class TableWidget extends BlockWidget {
  protected get cssClass() { return "omd-table" }

  protected renderInto(el: HTMLElement) {
    const rows = this.src.split("\n").filter(l => l.includes("|"))
    if (rows.length < 2) { el.textContent = this.src; return }
    const cells = (row: string) =>
      row.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim())
    const aligns = cells(rows[1]).map(c =>
      /^:-/.test(c) && /-:$/.test(c) ? "center" : /-:$/.test(c) ? "right" : /^:-/.test(c) ? "left" : "")

    const table = document.createElement("table")
    const thead = table.createTHead()
    const hr = thead.insertRow()
    for (const [i, c] of cells(rows[0]).entries()) {
      const th = document.createElement("th")
      th.textContent = c
      if (aligns[i]) th.style.textAlign = aligns[i] as "left"
      hr.appendChild(th)
    }
    const tbody = table.createTBody()
    for (const row of rows.slice(2)) {
      const tr = tbody.insertRow()
      for (const [i, c] of cells(row).entries()) {
        const td = tr.insertCell()
        td.textContent = c
        if (aligns[i]) td.style.textAlign = aligns[i] as "left"
      }
    }
    el.appendChild(table)
  }
}
