import { parseCell, type CellNode } from "../../parse/cell"
import { BlockWidget, type BlockEmbed } from "../blockWidget"

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

  protected get cssClass() { return "omd-table" }

  protected renderInto(el: HTMLElement) {
    const table = document.createElement("table")
    const thead = document.createElement("thead")
    const hr = document.createElement("tr")
    for (const [i, c] of this.table.header.entries()) {
      const th = document.createElement("th")
      renderTableCellContent(th, c, this.resolveSrc)
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
        renderTableCellContent(td, row[i] ?? "", this.resolveSrc)
        if (this.table.aligns[i]) td.style.textAlign = this.table.aligns[i]
        tr.appendChild(td)
      }
      tbody.appendChild(tr)
    }
    table.appendChild(tbody)
    el.appendChild(table)
  }
}
