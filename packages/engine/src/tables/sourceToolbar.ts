import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view"
import { cellAt, tableAt } from "./navigate"
import { tableToolChanges, type TableToolAction } from "./tools"
import type { TableData } from "./model"
import { icon, type IconName } from "../decorations/icons"

// 源码态表格浮层工具栏。表格聚焦时整表以源码网格呈现、没有块 widget，渲染态工具栏
// （.omd-table-toolbar，住在 widget 里）此时不可达 —— 结构编辑入口只剩键盘。这个浮层
// 补回鼠标入口，并且**只**改源码：行列一律由 cellAt 解析光标所在格，绝不猜。
const BUTTONS: readonly [TableToolAction, IconName, string][] = [
  ["align-left", "align-left", "Align column left"],
  ["align-center", "align-center", "Align column center"],
  ["align-right", "align-right", "Align column right"],
  ["insert-row", "row-insert-bottom", "Insert row below"],
  ["insert-col", "column-insert-right", "Insert column right"],
  ["delete-row", "row-remove", "Delete row"],
  ["delete-col", "column-remove", "Delete column"],
]

/** 浮层高度（px）：工具栏画在表格首行上方，position 用它的负偏移。 */
const TOOLBAR_OFFSET = 28

/** 测量阶段算出的表格首行屏幕坐标（相对编辑器容器）。 */
interface Placement {
  readonly top: number
  readonly left: number
}

/**
 * 执行一个结构动作的三方共享核心：显式给出行/列与表格相对基准点 `from`。
 * 渲染态工具栏拿 widget 的 pos/src/table 调用它，源码态浮层拿 cellAt 的结果调用它。
 * `table` 与 `source` 必须来自同一次解析；`tableToolChanges` 自己对源码校验，
 * 陈旧输入返回 null（→ false），这里绝不重试或猜测。
 */
export function applyTableToolAt(
  view: EditorView,
  from: number,
  source: string,
  table: TableData,
  row: number,
  col: number,
  act: TableToolAction,
): boolean {
  if (view.state.readOnly) return false
  const changes = tableToolChanges(act, source, table, row, col)
  if (!changes) return false
  view.dispatch({
    changes: changes.map(c => ({ from: from + c.from, to: from + c.to, insert: c.insert })),
  })
  return true
}

/** 源码态：行列一律由 cellAt 解析，绝不猜。 */
export function applyTableTool(view: EditorView, act: TableToolAction): boolean {
  const hit = cellAt(view.state, view.state.selection.main.head)
  if (!hit) return false
  return applyTableToolAt(
    view,
    hit.table.from,
    hit.table.source,
    hit.table.data,
    hit.slot.row,
    hit.slot.col,
    act,
  )
}

export const tableSourceToolbar = ViewPlugin.fromClass(class {
  readonly dom: HTMLDivElement

  constructor(private readonly view: EditorView) {
    this.dom = document.createElement("div")
    this.dom.className = "omd-table-toolbar-floating"
    this.dom.hidden = true
    for (const [act, name, title] of BUTTONS) {
      const btn = document.createElement("button")
      btn.type = "button"
      btn.dataset.act = act
      btn.appendChild(icon(name))
      btn.title = title
      btn.setAttribute("aria-label", title)
      // 按钮不抢焦点：光标离开表格会立刻让浮层消失、动作也就无目标（与渲染态
      // 工具栏同样的 mousedown 语义）。
      btn.addEventListener("mousedown", e => e.preventDefault())
      btn.addEventListener("click", e => {
        e.preventDefault()
        applyTableTool(this.view, act)
      })
      this.dom.appendChild(btn)
    }
    view.dom.appendChild(this.dom)
    // 构造时排一次定位：会话恢复到"光标已在表内"的场景不会等第一次 update。
    this.place()
  }

  /**
   * 定位浮层。
   *
   * coordsAtPos 会调用 readMeasured()，在 update 期间（UpdateState.Updating）直接
   * 抛 "Reading the editor layout isn't allowed during an update" —— 因此坐标**只能**
   * 在 requestMeasure 的 read 阶段读取（此时测量已完成、状态已是 Idle），DOM 写入
   * 放在 write 阶段。直接写在 update 里会被 catch 吞掉，浮层永远不出现。
   *
   * key 用插件实例：连续的 update 合并成一次测量，滚动/换格不会堆请求。
   */
  private place() {
    this.view.requestMeasure<Placement | null>({
      key: this,
      read: (view): Placement | null => {
        const state = view.state
        const table = tableAt(state, state.selection.main.head)
        if (!table || state.readOnly) return null
        try {
          // 构造/极端布局下视图可能尚未完成首次测量：拿不到坐标就按"暂不显示"处理。
          const coords = view.coordsAtPos(table.from)
          if (!coords) return null
          const host = view.dom.getBoundingClientRect()
          return {
            top: Math.max(0, coords.top - host.top - TOOLBAR_OFFSET),
            left: coords.left - host.left,
          }
        } catch {
          return null
        }
      },
      write: (placement) => {
        if (!placement) {
          this.dom.hidden = true
          return
        }
        this.dom.hidden = false
        this.dom.style.top = `${placement.top}px`
        this.dom.style.left = `${placement.left}px`
      },
    })
  }

  update(update: ViewUpdate) {
    // 光标离开表格/进入只读档：立即收起，不等下一次测量（避免残留一帧浮在半空，
    // 也让"没有表格上下文"在 DOM 上立刻可见）。位置变化交给测量阶段。
    const table = tableAt(update.state, update.state.selection.main.head)
    if (!table || update.state.readOnly) {
      this.dom.hidden = true
      return
    }
    this.place()
  }

  destroy() {
    this.dom.remove()
  }
})
