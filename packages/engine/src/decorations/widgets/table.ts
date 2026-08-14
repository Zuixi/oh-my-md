import { BlockWidget, type BlockEmbed } from "../blockWidget"

export type TableAlignment = "left" | "center" | "right" | ""

export interface TableData {
  header: string[]
  rows: string[][]
  aligns: TableAlignment[]
}

export function renderTableCellContent(parent: HTMLElement, text: string): void {
  const lines = text.split(/<br\s*\/?>/i)
  lines.forEach((line, lineIndex) => {
    if (lineIndex > 0) {
      parent.appendChild(document.createElement("br"))
    }
    renderInlineFormatted(parent, line)
  })
}

function renderInlineFormatted(parent: HTMLElement, text: string): void {
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|(?<!\w)_[^_]+_(?!\w)|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parent.appendChild(document.createTextNode(text.slice(lastIndex, match.index)))
    }

    const token = match[0]
    if (token.startsWith("`") && token.endsWith("`")) {
      const code = document.createElement("code")
      code.textContent = token.slice(1, -1)
      parent.appendChild(code)
    } else if (
      (token.startsWith("**") && token.endsWith("**")) ||
      (token.startsWith("__") && token.endsWith("__"))
    ) {
      const strong = document.createElement("strong")
      strong.textContent = token.slice(2, -2)
      parent.appendChild(strong)
    } else if (token.startsWith("~~") && token.endsWith("~~")) {
      const del = document.createElement("del")
      del.textContent = token.slice(2, -2)
      parent.appendChild(del)
    } else if (
      (token.startsWith("*") && token.endsWith("*")) ||
      (token.startsWith("_") && token.endsWith("_"))
    ) {
      const em = document.createElement("em")
      em.textContent = token.slice(1, -1)
      parent.appendChild(em)
    } else if (token.startsWith("[")) {
      const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
      if (linkMatch) {
        const a = document.createElement("a")
        a.textContent = linkMatch[1]
        a.href = linkMatch[2]
        a.target = "_blank"
        a.rel = "noopener noreferrer"
        a.className = "omd-link"
        parent.appendChild(a)
      } else {
        parent.appendChild(document.createTextNode(token))
      }
    } else {
      parent.appendChild(document.createTextNode(token))
    }

    lastIndex = match.index + token.length
  }

  if (lastIndex < text.length) {
    parent.appendChild(document.createTextNode(text.slice(lastIndex)))
  }
}

export class TableWidget extends BlockWidget {
  constructor(src: string, pos: number, readonly table: TableData, embed?: BlockEmbed) {
    super(src, pos, embed)
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
      renderTableCellContent(th, c)
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
        renderTableCellContent(td, row[i] ?? "")
        if (this.table.aligns[i]) td.style.textAlign = this.table.aligns[i]
        tr.appendChild(td)
      }
      tbody.appendChild(tr)
    }
    table.appendChild(tbody)
    el.appendChild(table)
  }
}
