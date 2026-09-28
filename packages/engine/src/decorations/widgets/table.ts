import { EditorView } from "@codemirror/view"
import { parseCell, type CellNode } from "../../parse/cell"
import {
  deleteTableColumn,
  deleteTableRow,
  insertTableColumn,
  insertTableRow,
  replaceTableCell,
  setTableColumnAlignment,
  type TableSourceChange,
} from "../../tables/edit"
import type { TableAlignment, TableCellData, TableData } from "../../tables/model"
import { BlockWidget, type BlockEmbed } from "../blockWidget"
import { registerBlockWidget, unregisterBlockWidget } from "../blockSelectionOverlay"
import { icon, type IconName } from "../icons"

interface PendingTableEdit {
  readonly pos: number
  readonly row: number
  readonly col: number
}

const pendingTableEdits = new WeakMap<EditorView, PendingTableEdit>()

/** 把对齐 action 装回为单条 marker 替换 change；列索引越界时返回 null。 */
function alignColumnChange(
  self: TableWidget,
  alignment: TableAlignment,
  col: number,
): TableSourceChange | null {
  return setTableColumnAlignment(self.src, self.table, col, alignment)
}

type TableToolAction =
  | "insert-row"
  | "insert-col"
  | "delete-row"
  | "delete-col"
  | "align-left"
  | "align-center"
  | "align-right"

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
    // ragged 行缺失源码槽的视觉填充：语义标识为不可用，不能打开输入框。
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

/** 对齐按钮的 active 高亮必须跟着当前列的对齐方式走（渲染态与原地补丁态共用）。 */
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

export class TableWidget extends BlockWidget {
  readonly table: TableData
  private view: EditorView | undefined
  private wrap: HTMLDivElement | undefined
  private row = 0
  private col = 0
  private editing: { el: HTMLElement; row: number; col: number } | null = null
  private cells: HTMLElement[][] = []
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

  override toDOM(view: EditorView) {
    this.view = view
    this.wrap = super.toDOM(view)
    ownDom(this, this.wrap)
    const wrap = this.wrap
    // `</>`（显式进源码）会在 BlockWidget 自己的 mousedown 里把光标移进块、把 widget
    // 连同输入框一起拆掉：未提交的单元格输入必须先落地。捕获阶段先于按钮处理器执行。
    wrap.addEventListener("mousedown", e => {
      if (e.button !== 0) return
      if (!(e.target instanceof Element) || !e.target.closest(".omd-block-edit")) return
      domOwner.get(wrap)?.commitPendingEdit()
    }, true)
    return this.wrap
  }

  // pass 1 原地刷新（仅 eq 失败才到这里）：CM 复用旧实例建的 DOM 与监听器，却把
  // tile.widget 换成这个新实例。这里把 DOM 重新认领为新实例的当前状态，只补丁变化的
  // 单元格 —— 提交一个单元格不再拆毁整表 DOM（无闪烁、无焦点丢失、O(变化格)）。
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
    this.cells = cells
    ownDom(this, dom)

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
    if (toolbar) applyAlignActive(toolbar, after.aligns[this.col] ?? "")

    // 迁移上一实例的活动态：正在编辑的输入框若仍在该格里就继续归新 owner 管。
    // 判据只看"输入框还在不在格里"——不用 isConnected：widget DOM 在 CM 测量/差异
    // 期间可以是 detached，而它的销毁只经 destroy()，不由脱离文档触发。
    this.row = prev.row
    this.col = prev.col
    this.editing = prev.editing && prev.editing.el.querySelector("input.omd-table-edit")
      ? prev.editing
      : null

    registerBlockWidget(this, dom)
    if (prev !== this) unregisterBlockWidget(prev)

    // DOM 存活 → pending 编辑同步重开：不需要 renderInto 那条 queueMicrotask 交接，
    // Tab/Enter 连打时输入框不经历"销毁再重建"的空窗。两阶段结构操作同样要接着跑，
    // 否则单元格提交后走原地路径会把它丢掉（结构不变 → 不经过 toDOM）。
    this.consumePendingEdits(true)
    this.consumePendingTool()
    return true
  }

  override destroy(dom?: HTMLElement) {
    if (dom) releaseDom(this, dom)
    super.destroy(dom)
  }

  override ignoreEvent(event: Event) {
    return super.ignoreEvent(event)
      || event.type === "keydown"
      || event.type === "keyup"
      || event.type === "keypress"
      || event.type === "input"
      || event.type === "click"
  }

  // wrap（padding/边框/工具栏空隙等非单元格表面）点击不注入光标：单元格就地
  // 编辑是主入口，误触 wrap 整表翻源码就是表格闪烁。显式源码入口只剩 `</>`
  // 按钮（blockWidget 基类自带处理器）与键盘 ↑/↓（blockMotionKeymap 有意进源码）。
  protected enterSourceOnClick(): boolean { return false }

  protected get cssClass() { return "omd-table" }

  protected renderInto(el: HTMLElement) {
    // 只读档（HUGE Live 预览）禁用表格编辑 affordance；readOnly 建档时固定，
    // widget 生命周期内无翻转路径。replace() 的 dispatch 守卫仍是权威防线。
    const readonly = this.view?.state?.readOnly ?? false
    // 仅剩一行/一列时结构性删除无效：工具栏按当前模型禁用对应按钮，
    // 用户在编辑状态下点 disabled 控件不会落入「先提交、后 no-op」路径。
    const canDeleteRow = this.table.rows.length > 1
    const canDeleteCol = this.table.header.cells.length > 1
    const toolbar = document.createElement("div")
    toolbar.className = "omd-table-toolbar"
    // 当前活动列的对齐方式 —— 用于工具栏按钮高亮「当前状态」
    const currentAlign: TableAlignment = this.table.aligns[this.col] ?? ""
    for (const [act, iconName, title] of [
      ["align-left", "align-left", "Align column left"],
      ["align-center", "align-center", "Align column center"],
      ["align-right", "align-right", "Align column right"],
      ["insert-row", "row-insert-bottom", "Insert row below"],
      ["insert-col", "column-insert-right", "Insert column right"],
      ["delete-row", "row-remove", "Delete row"],
      ["delete-col", "column-remove", "Delete column"],
    ] as const satisfies readonly [string, IconName, string][]) {
      const btn = document.createElement("button")
      btn.type = "button"
      btn.dataset.act = act
      btn.appendChild(icon(iconName))
      btn.title = title
      btn.setAttribute("aria-label", title)
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
        // 实例轮换后工具栏按钮仍绑在旧实例上：按 wrap 取当前 owner。
        domOwner.get(el)?.tool(act)
      })
      toolbar.appendChild(btn)
    }
    applyAlignActive(toolbar, currentAlign)
    el.appendChild(toolbar)

    this.cells = []
    const table = document.createElement("table")
    const thead = document.createElement("thead")
    const hr = document.createElement("tr")
    const head: HTMLElement[] = []
    for (const [i, c] of this.table.header.cells.entries()) {
      const th = document.createElement("th")
      renderCellSlot(th, c ?? null, this.resolveSrc)
      if (this.table.aligns[i]) th.style.textAlign = this.table.aligns[i]
      this.bindCell(el, th, 0, i)
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
        renderCellSlot(td, cell ?? null, this.resolveSrc)
        if (this.table.aligns[i]) td.style.textAlign = this.table.aligns[i]
        this.bindCell(el, td, r + 1, i)
        line.push(td)
        tr.appendChild(td)
      }
      this.cells.push(line)
      tbody.appendChild(tr)
    }
    table.appendChild(tbody)
    el.appendChild(table)

    // 两阶段工具栏操作（删除 active 行/列与单元格提交重叠时）：单元格已先提交，
    // 重建后的本表在此消费 pending，在微任务里对 fresh Lezer 元数据派发结构操作。
    // Consume before scheduling：删除 entry 后再排微任务，任何后续失败都不会留下
    // 可被其他表/视图消费的残留；位置不匹配（不同表/不同位置）则不触碰 entry。
    this.consumePendingEdits(false)
    this.consumePendingTool()
  }

  /**
   * 消费本视图为该表排队的键盘续编（Tab/Enter 提交后的落点格）。
   * `sync`：DOM 由 updateDOM 原地续用时同步重开（无微任务空窗，连打 Tab 不闪）；
   * toDOM 全量重建路径仍走微任务等 DOM 挂载。
   */
  private consumePendingEdits(sync: boolean): void {
    const pending = this.view && pendingTableEdits.get(this.view)
    if (!pending || pending.pos !== this.livePos()) return
    pendingTableEdits.delete(this.view!)
    const cell = this.cells[pending.row]?.[pending.col]
    if (!cell || !this.cellData(pending.row, pending.col)) return
    if (sync) this.startEdit(cell, pending.row, pending.col)
    else queueMicrotask(() => { if (cell.isConnected) this.startEdit(cell, pending.row, pending.col) })
  }

  /**
   * 消费两阶段工具栏操作。结构操作必然改变行列数 → 下一次装饰重建走 toDOM 全量重建，
   * 因此这里只补派发一次结构事务。dispatch 必须等到 CM 更新周期结束：updateDOM 本身
   * 就在更新周期内，同步 dispatch 会抛 "update is in progress"。
   */
  private consumePendingTool(): void {
    const pendingTool = this.view && pendingTableTools.get(this.view)
    if (!pendingTool || pendingTool.pos !== this.livePos()) return
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

  private cellData(row: number, col: number) {
    return row === 0 ? this.table.header.cells[col] : this.table.rows[row - 1]?.cells[col]
  }

  private bindCell(wrap: HTMLElement, el: HTMLElement, row: number, col: number) {
    el.addEventListener("mousedown", e => {
      e.preventDefault()
      e.stopPropagation()
      if (e.target instanceof HTMLInputElement) return
      // 监听器闭包的是建 DOM 的那个实例；CM pass-1 复用后 owner 已轮换成新实例
      // （见 domOwner 注释），所以每次事件都按 wrap 解析当前 owner。
      const owner = domOwner.get(wrap)
      if (!owner || !owner.cellData(row, col)) return
      owner.row = row
      owner.col = col
      owner.startEdit(el, row, col)
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
    const previous = this.editing
    if (previous) {
      const input = previous.el.querySelector<HTMLInputElement>("input.omd-table-edit")
      const cell = this.cellData(previous.row, previous.col)
      if (input && cell && input.value !== cell.source) {
        // 换格即提交：绝不静默丢弃已输入内容。落点格交给 pending 重建路径打开 ——
        // dispatch 之后本实例就不再是 owner（updateDOM 轮换），不能继续在 this 上开编辑器。
        this.commitEdit(0, undefined, { row, col })
        return
      }
      // 无改动：直接收掉旧编辑器（不产生事务、不留下多余的 undo 步）。
      this.cancelEdit()
    }
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
    const wrap = this.wrap
    input.addEventListener("mousedown", e => {
      e.stopPropagation()
    })
    // 点击/聚焦到表格之外（正文、其它 widget、应用外）必须把输入落地：
    // 旧行为是 focusout 后整块重建 → 用户输入静默消失（A2）。
    input.addEventListener("focusout", () => {
      const owner = (wrap && domOwner.get(wrap)) ?? this
      owner.commitPendingEdit()
    })
    input.addEventListener("keydown", e => {
      // IME 组词中的 Enter/Escape 是候选确认/取消，不能当成单元格提交/放弃（A3）。
      if (e.isComposing || e.keyCode === 229) return
      // 同上：输入框可能由前一个实例创建，事件必须派发给当前 owner。
      const owner = (wrap && domOwner.get(wrap)) ?? this
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault()
        const tab = e.key === "Tab"
        const shift = e.shiftKey
        if (tab) {
          // Tab 仍走横向遍历：右/左换格，末列 Tab 自动追加新行
          owner.commitEdit(shift ? -1 : 1, shift ? "shift-tab" : "tab")
        } else {
          // Enter 改为纵向录入：移动到「正下方同行 / Shift+Enter 正上方同行」，
          // 末行 Enter 自动追加新行并停留在同列，对齐 Excel / Numbers 的高频录入手感。
          owner.commitEditVertical(shift ? -1 : 1)
        }
      } else if (e.key === "Escape") {
        e.preventDefault()
        owner.cancelEdit()
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

  /**
   * 丢掉输入框之前把未提交的值落地（失焦、显式进源码、widget 被拆之前的最后一道）。
   * 幂等：Escape/提交路径已把 `editing` 置空，重复调用（focusout 在 DOM 替换时补发）无操作。
   */
  private commitPendingEdit(): void {
    const edit = this.editing
    if (!edit) return
    const input = edit.el.querySelector<HTMLInputElement>("input.omd-table-edit")
    const cell = this.cellData(edit.row, edit.col)
    // 无输入框或源码槽已失效（陈旧元数据）：还原渲染，绝不派发越界事务。
    if (!input || !cell) { this.cancelEdit(); return }
    // 未改动：只收掉编辑器，不产生事务。
    if (input.value === cell.source) { this.cancelEdit(); return }
    this.commitEdit(0)
  }

  private commitEdit(move: 1 | -1 | 0, fromKey?: "tab" | "shift-tab" | "enter", explicitDest?: { row: number; col: number }) {
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
    let dest = explicitDest ?? (neighbor && this.cellData(neighbor.row, neighbor.col) ? neighbor : null)
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

  // Enter 键的纵向录入：同列换行（dir=+1）/ Shift+Enter 上行（dir=-1）。
  // 越界表尾自动追加新行并停留同列，模拟 Excel / Numbers 的高频录入手感。
  // 失败时（首格 Shift+Enter 越界）保持输入框挂载，等价于 commitEdit 的「陈旧元数据」兜底。
  private commitEditVertical(dir: 1 | -1) {
    const edit = this.editing
    const input = edit?.el.querySelector("input.omd-table-edit") as HTMLInputElement | null
    if (!edit || !input) return
    const cell = this.cellData(edit.row, edit.col)
    if (!cell) return
    const change = replaceTableCell(this.src, cell, input.value)
    if (!change) return
    this.editing = null
    this.clearActive()
    const targetRow = edit.row + dir
    const totalRows = this.table.rows.length + 1
    let dest: { row: number; col: number } | null = null
    let changes: TableSourceChange[] = [change]

    if (targetRow === 0) {
      // 进入表头（一般不发生；保留对称语义）。
      if (this.table.header.cells[edit.col]) {
        dest = { row: 0, col: edit.col }
      }
    } else if (targetRow > 0 && targetRow - 1 < this.table.rows.length) {
      // 数据行实际存在：检查该行 ragged 槽可用性。
      const rowCells = this.table.rows[targetRow - 1]?.cells
      if (rowCells && rowCells[edit.col]) {
        dest = { row: targetRow, col: edit.col }
      }
    } else if (targetRow >= totalRows && dir === 1) {
      // 末行 Enter：同一事务追加新行并停留同列（oldRowCount + 1 行、edit.col）
      const inserted = insertTableRow(this.src, this.table, this.table.rows.length)
      if (inserted && changesNonOverlapping([change, ...inserted])) {
        changes = [...changes, ...inserted].sort((a, b) => a.from - b.from)
        dest = { row: this.table.rows.length + 1, col: edit.col }
      }
    }
    // dir === -1 越界到 -1（首格 Shift+Enter）或合成格不可用：等同于 no-op 提交
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
    if (act === "insert-row") return insertTableRow(this.src, this.table, row)
    if (act === "insert-col") return insertTableColumn(this.src, this.table, col)
    if (act === "delete-row") return deleteTableRow(this.src, this.table, row - 1)
    if (act === "delete-col") return deleteTableColumn(this.src, this.table, col)
    if (act === "align-left") {
      const change = alignColumnChange(this, "left", col)
      return change ? [change] : null
    }
    if (act === "align-center") {
      const change = alignColumnChange(this, "center", col)
      return change ? [change] : null
    }
    if (act === "align-right") {
      const change = alignColumnChange(this, "right", col)
      return change ? [change] : null
    }
    return null
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
