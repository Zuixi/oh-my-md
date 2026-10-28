import { EditorView } from "@codemirror/view"
import { parseCell, type CellNode } from "../../parse/cell"
import type { TableAlignment, TableCellData, TableData } from "../../tables/model"
import { tableAt } from "../../tables/navigate"
import { applyTableToolAt } from "../../tables/sourceToolbar"
import { TABLE_TOOL_BUTTONS } from "../../tables/tools"
import { BlockWidget, applyBlockEmbed, type BlockEmbed } from "../blockWidget"
import { registerBlockWidget, unregisterBlockWidget } from "../blockSelectionOverlay"
import { estimateTableHeightPx } from "../widgetHeights"
import { icon } from "../icons"

type ResolveSrc = (src: string) => string

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
function renderCellSlot(el: HTMLElement, cell: TableCellData | null, resolveSrc?: ResolveSrc): void {
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
  renderTableCellContent(el, cell.text, resolveSrc)
}

/** 对齐按钮的 active 高亮必须跟着目标列的对齐方式走（渲染态与原地补丁态共用）。 */
function applyAlignActive(toolbar: HTMLElement, currentAlign: TableAlignment): void {
  for (const act of ["align-left", "align-center", "align-right"] as const) {
    const btn = toolbar.querySelector<HTMLElement>(`[data-act='${act}']`)
    if (btn) btn.classList.toggle("omd-table-tool-active", act === `align-${currentAlign}`)
  }
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
  ) {
    super(src, pos, embed)
    this.table = table
  }

  private get equalityKey(): string {
    return (this.equalityKeyCache ??= tableEqualityKey(this.table))
  }

  eq(other: TableWidget) {
    // resolveSrc 不参与相等性：由宿主 facet 注入，只在编辑器配置重建时变化。
    // 先比 src/embed（提交热路径必变，直接短路），相同才比较结构键。
    return super.eq(other) && this.equalityKey === other.equalityKey
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
    const head = Array.from(dom.querySelectorAll<HTMLElement>("thead th"))
    const rows = Array.from(dom.querySelectorAll<HTMLElement>("tbody tr"))
      .map(tr => Array.from(tr.children) as HTMLElement[])
    const cells = head.length > 0 ? [head, ...rows] : rows
    if (cells.length === 0) return false

    this.view = view
    this.wrap = dom as HTMLDivElement
    ownDom(this, dom)
    // 旧 DOM 上的嵌入类/深度属于上一个实例（CM pass-1 只换了 tile.widget）：
    // 整块刷新成当前嵌入值，深度变深/离开列表/进出引用都不会留旧状态。
    applyBlockEmbed(dom, this.embed)
    // 迁移上一实例的工具栏目标：行列不变时 hover 语义延续（没有 hover 就仍是没有）。
    this.row = prev.row
    this.col = prev.col
    this.hovered = prev.hovered

    for (let r = 0; r < cells.length; r++) {
      const beforeRow = r === 0 ? before.header : before.rows[r - 1]
      const afterRow = r === 0 ? after.header : after.rows[r - 1]
      for (let c = 0; c < cells[r].length; c++) {
        const el = cells[r][c]
        const was = beforeRow?.cells[c] ?? null
        const now = afterRow?.cells[c] ?? null
        // source 相同即同一渲染输入（text 是 source 的纯函数）；null ↔ 非 null 也在此区分。
        if (was?.source !== now?.source) renderCellSlot(el, now, this.resolveSrc)
        const align = after.aligns[c] ?? ""
        if (align) el.style.textAlign = align
        else el.style.removeProperty("text-align")
      }
    }
    const toolbar = dom.querySelector<HTMLElement>(".omd-table-toolbar")
    if (toolbar) this.syncToolbar(toolbar)

    registerBlockWidget(this, dom)
    if (prev !== this) unregisterBlockWidget(prev)
    return true
  }

  override destroy(dom?: HTMLElement) {
    if (dom) releaseDom(this, dom)
    super.destroy(dom)
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
    if (!cellEl) return this.livePos()
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
      renderCellSlot(th, c ?? null, this.resolveSrc)
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
        renderCellSlot(td, cell ?? null, this.resolveSrc)
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
