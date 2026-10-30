import {
  parseComplexTableBlock,
  type ComplexTableCell,
  type ComplexTableInline,
  type ComplexTableModel,
} from "../../parse/complexTable"
import { BlockWidget, type BlockEmbed } from "../blockWidget"
import { estimateComplexTableHeightPx } from "../widgetHeights"
import type { ResolveSrc } from "./tableCell"

const WRAPPER_TAG: Readonly<Record<string, string>> = {
  strong: "strong",
  emphasis: "em",
  strike: "del",
  underline: "u",
  highlight: "mark",
  kbd: "kbd",
  subscript: "sub",
  superscript: "sup",
}

export class ComplexTableWidget extends BlockWidget {
  readonly model: ComplexTableModel
  readonly resolveSrc?: ResolveSrc

  constructor(
    src: string,
    pos: number,
    model: ComplexTableModel,
    embed?: BlockEmbed,
    resolveSrc?: ResolveSrc,
  ) {
    super(src, pos, embed)
    this.model = model
    this.resolveSrc = resolveSrc
  }

  protected get cssClass(): string {
    return "omd-table omd-complex-table"
  }

  override get estimatedHeight(): number {
    return estimateComplexTableHeightPx(this.model)
  }

  override eq(other: ComplexTableWidget): boolean {
    return super.eq(other)
  }

  protected override enterSourceOnClick(): boolean {
    return true
  }

  protected override shouldEnterSource(event: MouseEvent): boolean {
    const target = event.target
    return target instanceof Element && target.closest("td, th") !== null
  }

  protected renderInto(container: HTMLElement): Promise<void> | void {
    const tableEl = document.createElement("table")
    const { headRows, bodyRows } = splitDisplayRows(this.model.rows)

    if (headRows.length > 0) {
      const thead = document.createElement("thead")
      for (const row of headRows) {
        thead.appendChild(renderRow(row, this.resolveSrc))
      }
      tableEl.appendChild(thead)
    }

    const tbody = document.createElement("tbody")
    for (const row of bodyRows.length > 0 ? bodyRows : this.model.rows) {
      if (headRows.length > 0 && bodyRows.length === 0) break
      tbody.appendChild(renderRow(row, this.resolveSrc))
    }
    if (tbody.childNodes.length > 0) {
      tableEl.appendChild(tbody)
    }

    container.replaceChildren(tableEl)
  }
}

export function createComplexTableWidget(
  src: string,
  pos: number,
  embed?: BlockEmbed,
  resolveSrc?: ResolveSrc,
): ComplexTableWidget | null {
  const model = parseComplexTableBlock(src)
  return model ? new ComplexTableWidget(src, pos, model, embed, resolveSrc) : null
}

function splitDisplayRows(rows: readonly (readonly ComplexTableCell[])[]): {
  readonly headRows: readonly (readonly ComplexTableCell[])[]
  readonly bodyRows: readonly (readonly ComplexTableCell[])[]
} {
  let headCount = 0
  let requiredHeadEnd = 0
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const allHeader = row.length > 0 && row.every(cell => cell.header && cell.scope !== "row")
    if (!allHeader) break
    const rowEnd = Math.max(...row.map(cell => i + cell.rowSpan))
    requiredHeadEnd = Math.max(requiredHeadEnd, rowEnd)
    headCount = i + 1
  }
  if (requiredHeadEnd > headCount) {
    return { headRows: [], bodyRows: rows }
  }
  return {
    headRows: rows.slice(0, headCount),
    bodyRows: rows.slice(headCount),
  }
}

function renderRow(
  cells: readonly ComplexTableCell[],
  resolveSrc?: ResolveSrc,
): HTMLTableRowElement {
  const tr = document.createElement("tr")
  for (const cell of cells) {
    const el = document.createElement(cell.header ? "th" : "td")
    if (cell.rowSpan > 1) el.rowSpan = cell.rowSpan
    if (cell.colSpan > 1) el.colSpan = cell.colSpan
    if (cell.header && (cell.scope === "row" || cell.scope === "col")) {
      el.scope = cell.scope
    }
    if (cell.align) {
      el.style.textAlign = cell.align
    }
    for (const inline of cell.children) {
      renderInline(el, inline, resolveSrc)
    }
    tr.appendChild(el)
  }
  return tr
}

function renderInline(
  parent: HTMLElement,
  node: ComplexTableInline,
  resolveSrc?: ResolveSrc,
): void {
  switch (node.type) {
    case "text":
      parent.appendChild(document.createTextNode(node.value))
      return
    case "break":
      parent.appendChild(document.createElement("br"))
      return
    case "code": {
      const code = document.createElement("code")
      code.textContent = node.value
      parent.appendChild(code)
      return
    }
    case "link": {
      const a = document.createElement("a")
      a.href = node.href
      if (node.title !== null) a.title = node.title
      a.target = "_blank"
      a.rel = "noopener noreferrer"
      a.className = "omd-link"
      for (const child of node.children) renderInline(a, child, resolveSrc)
      parent.appendChild(a)
      return
    }
    case "image": {
      const img = document.createElement("img")
      img.src = resolveSrc ? resolveSrc(node.src) : node.src
      img.alt = node.alt
      if (node.title !== null) img.title = node.title
      img.className = "omd-image"
      img.onerror = () => {
        img.replaceWith(
          Object.assign(document.createElement("span"), {
            className: "omd-image-broken",
            textContent: node.src,
          }),
        )
      }
      parent.appendChild(img)
      return
    }
    default: {
      const tag = WRAPPER_TAG[node.type]
      if (!tag) return
      const wrapper = document.createElement(tag)
      for (const child of node.children) renderInline(wrapper, child, resolveSrc)
      parent.appendChild(wrapper)
    }
  }
}
