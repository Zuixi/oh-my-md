import type { EditorView } from "@codemirror/view"
import type { PasteRange } from "@omd/engine"
import {
  clearPasteBookmark,
  pasteViewDestroyed,
  readPasteBookmark,
  startPasteBookmark,
  type PasteBookmarkHandle,
} from "./pasteBookmark"

export interface PasteJobOptions {
  readonly getTabId: () => number
  readonly getDocumentId: () => number
  readonly getDocPath: () => string | null
  readonly onError: (message: string) => void
}

export type PasteJobTarget =
  | { readonly kind: "active"; readonly ranges: readonly PasteRange[]; readonly documentPath: string | null }
  | { readonly kind: "cancelled" }

const queues = new WeakMap<EditorView, Promise<void>>()

export function runPasteJob<T>(
  view: EditorView,
  options: PasteJobOptions,
  acquire: () => Promise<T>,
  apply: (payload: T, currentTarget: () => PasteJobTarget) => Promise<void>,
): Promise<void> {
  if (view.state.readOnly || pasteViewDestroyed(view)) return Promise.resolve()

  const tabId = options.getTabId()
  const documentId = options.getDocumentId()
  const documentPath = options.getDocPath()
  const handles = view.state.selection.ranges.map(range =>
    startPasteBookmark(view, range.from, range.to))

  let acquisition: Promise<T>
  try {
    acquisition = acquire()
  } catch (error) {
    acquisition = Promise.reject(error)
  }
  const settled = acquisition.then(
    value => ({ ok: true as const, value }),
    error => ({ ok: false as const, error }),
  )

  const currentTarget = (): PasteJobTarget => {
    if (
      pasteViewDestroyed(view) ||
      view.state.readOnly ||
      options.getTabId() !== tabId ||
      options.getDocumentId() !== documentId ||
      options.getDocPath() !== documentPath
    ) return { kind: "cancelled" }
    const ranges: PasteRange[] = []
    for (const handle of handles) {
      const range = readPasteBookmark(view.state, handle)
      if (!range || range.kind !== "active") return { kind: "cancelled" }
      ranges.push({ from: range.from, to: range.to })
    }
    return { kind: "active", ranges, documentPath }
  }

  const predecessor = queues.get(view) ?? Promise.resolve()
  const job = predecessor.catch(() => undefined).then(async () => {
    const result = await settled
    if (!result.ok) throw result.error
    await apply(result.value, currentTarget)
  }).catch(error => {
    options.onError(error instanceof Error ? error.message : String(error))
  }).finally(() => {
    for (const handle of handles) clearHandle(view, handle)
  })
  queues.set(view, job)
  return job
}

function clearHandle(view: EditorView, handle: PasteBookmarkHandle): void {
  if (!pasteViewDestroyed(view)) clearPasteBookmark(view, handle)
}
