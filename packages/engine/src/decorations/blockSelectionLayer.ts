import {
  EditorSelection,
  StateEffect,
  type Extension,
  type SelectionRange,
} from "@codemirror/state"
import {
  Direction,
  EditorView,
  RectangleMarker,
  ViewPlugin,
  layer,
  type ViewUpdate,
} from "@codemirror/view"
import { mountedBlockWidgets } from "./blockSelectionOverlay"

/** Dispatched when an inner `.omd-block-body` scrolls horizontally during a selection. */
const widgetSelectionScrollTick = StateEffect.define<null>()

function scrollBase(view: EditorView): { left: number; top: number } {
  const rect = view.scrollDOM.getBoundingClientRect()
  const left = view.textDirection === Direction.LTR
    ? rect.left
    : rect.right - view.scrollDOM.clientWidth * view.scaleX
  return {
    left: left - view.scrollDOM.scrollLeft * view.scaleX,
    top: rect.top - view.scrollDOM.scrollTop * view.scaleY,
  }
}

export interface WidgetPointerTarget {
  /** True when the viewport point hits a mounted `BlockWidget` implementing `sourceOffsetAtPoint`. */
  readonly insideWidget: boolean
  /** Mapped document offset inside that widget, or `null` when over a non-selectable gap/chrome. */
  readonly offset: number | null
}

/**
 * Inspect whether `(clientX, clientY)` hits a mounted `BlockWidget` that participates in
 * rendered selection, and resolve its document offset when over a selectable slot.
 */
export function widgetPointerTargetAtPoint(
  view: EditorView,
  clientX: number,
  clientY: number,
): WidgetPointerTarget {
  const doc = view.dom.ownerDocument
  const hit = typeof doc.elementFromPoint === "function"
    ? doc.elementFromPoint(clientX, clientY)
    : null
  if (!hit) return { insideWidget: false, offset: null }
  for (const { widget, dom, from, to } of mountedBlockWidgets(view)) {
    if (!widget.sourceOffsetAtPoint || !dom.contains(hit)) continue
    return {
      insideWidget: true,
      offset: widget.sourceOffsetAtPoint(view, dom, { from, to }, clientX, clientY),
    }
  }
  return { insideWidget: false, offset: null }
}

/**
 * Resolve a viewport pointer position onto an absolute document offset inside any
 * mounted `BlockWidget` that implements `sourceOffsetAtPoint`.
 */
export function widgetSourceOffsetAtPoint(
  view: EditorView,
  clientX: number,
  clientY: number,
): number | null {
  return widgetPointerTargetAtPoint(view, clientX, clientY).offset
}

export function blockWidgetSelectionMarkers(view: EditorView): RectangleMarker[] {
  const ranges = view.state.selection.ranges
  const nonEmpty: SelectionRange[] = ranges.filter(range => !range.empty)
  if (nonEmpty.length === 0) return []
  const widgets = mountedBlockWidgets(view).filter(entry => entry.widget.selectionRects)
  if (widgets.length === 0) return []

  const base = scrollBase(view)
  const scaleX = view.scaleX || 1
  const scaleY = view.scaleY || 1
  const markers: RectangleMarker[] = []

  for (const sel of nonEmpty) {
    for (const { widget, dom, from, to } of widgets) {
      if (sel.to <= from || sel.from >= to) continue
      // Fully covered blocks are painted by `.omd-block-covered` to avoid double tinting.
      if (sel.from <= from && sel.to >= to) continue
      const rects = widget.selectionRects!(view, dom, { from, to }, { from: sel.from, to: sel.to })
      for (const rect of rects) {
        if (rect.width <= 0 || rect.height <= 0) continue
        markers.push(new RectangleMarker(
          "omd-widget-selected-text",
          (rect.left - base.left) / scaleX,
          (rect.top - base.top) / scaleY,
          rect.width / scaleX,
          rect.height / scaleY,
        ))
      }
    }
  }
  return markers
}

const blockWidgetSelectionLayer = layer({
  above: true,
  class: "omd-widget-selection-layer",
  markers: blockWidgetSelectionMarkers,
  update(update: ViewUpdate): boolean {
    return update.selectionSet
      || update.docChanged
      || update.viewportChanged
      || update.geometryChanged
      || update.transactions.some(tr => tr.effects.some(effect => effect.is(widgetSelectionScrollTick)))
  },
})

/**
 * Horizontal scrolling inside `.omd-block-body` does not produce a CodeMirror ViewUpdate,
 * so forward it (rAF-throttled, only while a non-empty selection exists) to redraw the layer.
 */
const blockWidgetScrollSync = ViewPlugin.fromClass(
  class {
    private rafId: number | null = null
    private readonly onScroll = (event: Event) => {
      const target = event.target
      if (!(target instanceof HTMLElement) || !target.classList.contains("omd-block-body")) return
      if (this.view.state.selection.ranges.every(range => range.empty)) return
      if (this.rafId !== null) return
      this.rafId = requestAnimationFrame(() => {
        this.rafId = null
        if (!this.view.dom.isConnected) return
        if (this.view.state.selection.ranges.every(range => range.empty)) return
        this.view.dispatch({ effects: widgetSelectionScrollTick.of(null) })
      })
    }

    constructor(private readonly view: EditorView) {
      view.scrollDOM.addEventListener("scroll", this.onScroll, true)
    }

    destroy() {
      this.view.scrollDOM.removeEventListener("scroll", this.onScroll, true)
      if (this.rafId !== null) {
        cancelAnimationFrame(this.rafId)
        this.rafId = null
      }
    }
  },
)

function removeRangeAround(sel: EditorSelection, pos: number): EditorSelection | null {
  for (let i = 0; i < sel.ranges.length; i++) {
    const { from, to } = sel.ranges[i]
    if (from <= pos && to >= pos) {
      return EditorSelection.create(
        sel.ranges.slice(0, i).concat(sel.ranges.slice(i + 1)),
        sel.mainIndex === i ? 0 : sel.mainIndex - (sel.mainIndex > i ? 1 : 0),
      )
    }
  }
  return null
}

/**
 * Allow drags that begin on plain text outside a rendered block widget to map their
 * head smoothly inside any mounted widget that implements `sourceOffsetAtPoint`.
 * Multi-click gestures (`event.detail > 1`) stay on CodeMirror's stock word/line selector.
 */
const blockWidgetMouseSelection = EditorView.mouseSelectionStyle.of((view, event) => {
  if (event.detail > 1) return null
  if (!mountedBlockWidgets(view).some(entry => entry.widget.sourceOffsetAtPoint)) return null

  const startPos = view.posAtCoords({ x: event.clientX, y: event.clientY }, false)
  let start = startPos
  let lastPos = startPos
  let startSel = view.state.selection

  return {
    update(update) {
      if (update.docChanged) {
        start = update.changes.mapPos(start)
        lastPos = update.changes.mapPos(lastPos)
        startSel = startSel.map(update.changes)
      }
    },
    get(curEvent, extend, multiple) {
      const target = widgetPointerTargetAtPoint(view, curEvent.clientX, curEvent.clientY)
      // When the pointer crosses padding/border/chrome inside a rendered widget that owns
      // its own coordinate mapping, hold the previous head rather than letting CodeMirror's
      // `posAtCoords` snap to the widget's outer boundary.
      const curPos = target.insideWidget
        ? (target.offset ?? lastPos)
        : view.posAtCoords({ x: curEvent.clientX, y: curEvent.clientY }, false)
      lastPos = curPos
      const range = start !== curPos && !extend
        ? EditorSelection.range(start, curPos)
        : EditorSelection.cursor(curPos)
      if (extend) {
        return startSel.replaceRange(startSel.main.extend(range.from, range.to, range.assoc))
      }
      if (multiple && startSel.ranges.length > 1) {
        const removed = removeRangeAround(startSel, curPos)
        if (removed) return removed
      }
      if (multiple) return startSel.addRange(range)
      return EditorSelection.create([range])
    },
  }
})

export const blockWidgetSelectionExtension: Extension = [
  blockWidgetSelectionLayer,
  blockWidgetScrollSync,
  blockWidgetMouseSelection,
]
