import { StateEffect, StateField, type ChangeDesc, type EditorState, type Extension } from "@codemirror/state"
import { EditorView, ViewPlugin } from "@codemirror/view"

export interface PasteBookmarkHandle { readonly id: string }
export type MappedPasteRange =
  | { readonly kind: "active"; readonly from: number; readonly to: number }
  | { readonly kind: "invalid" }
  | null

interface Bookmark { readonly from: number; readonly to: number; readonly invalid: boolean }
const addBookmark = StateEffect.define<{ readonly id: string; readonly from: number; readonly to: number }>()
const clearBookmark = StateEffect.define<string>()
let nextBookmarkId = 1
const destroyedViews = new WeakSet<EditorView>()

const pasteBookmarks = StateField.define<ReadonlyMap<string, Bookmark>>({
  create: () => new Map(),
  update(value, transaction) {
    if (transaction.reconfigured) value = new Map()
    const next = new Map(value)
    if (transaction.docChanged) {
      for (const [id, bookmark] of next) {
        if (bookmark.invalid) continue
        if (bookmark.from !== bookmark.to && touchesRange(transaction.changes, bookmark.from, bookmark.to)) {
          next.set(id, { ...bookmark, invalid: true })
          continue
        }
        const collapsed = bookmark.from === bookmark.to
        next.set(id, {
          from: transaction.changes.mapPos(bookmark.from, 1),
          to: transaction.changes.mapPos(bookmark.to, collapsed ? 1 : -1),
          invalid: false,
        })
      }
    }
    for (const effect of transaction.effects) {
      if (effect.is(addBookmark)) {
        next.set(effect.value.id, { from: effect.value.from, to: effect.value.to, invalid: false })
      } else if (effect.is(clearBookmark)) {
        next.delete(effect.value)
      }
    }
    return next
  },
})
const pasteViewLifetime = ViewPlugin.fromClass(class {
  constructor(private readonly view: EditorView) {
    destroyedViews.delete(view)
  }
  destroy() {
    destroyedViews.add(this.view)
  }
})
export const pasteBookmarkExtension: Extension = [pasteBookmarks, pasteViewLifetime]
export const pasteViewDestroyed = (view: EditorView): boolean => destroyedViews.has(view)

function touchesRange(changes: ChangeDesc, from: number, to: number): boolean {
  let touched = false
  changes.iterChangedRanges((fromA, toA) => {
    if (fromA <= to && toA >= from) touched = true
  })
  return touched
}

export function startPasteBookmark(view: EditorView, from: number, to: number): PasteBookmarkHandle {
  const handle = { id: `paste-${nextBookmarkId++}` }
  view.dispatch({ effects: addBookmark.of({ id: handle.id, from, to }) })
  return handle
}

export function readPasteBookmark(state: EditorState, handle: PasteBookmarkHandle): MappedPasteRange {
  const bookmark = state.field(pasteBookmarks, false)?.get(handle.id)
  if (!bookmark) return null
  return bookmark.invalid ? { kind: "invalid" } : { kind: "active", from: bookmark.from, to: bookmark.to }
}

export function clearPasteBookmark(view: EditorView, handle: PasteBookmarkHandle): void {
  if (!pasteViewDestroyed(view)) view.dispatch({ effects: clearBookmark.of(handle.id) })
}
