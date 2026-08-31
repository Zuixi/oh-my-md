import { useSyncExternalStore } from "react"
import type { EditorStatus } from "./Editor"

const DEFAULT_STATUS: EditorStatus = { cursor: "1:1", mode: "live" }

export interface EditorStatusStore {
  getSnapshot(): EditorStatus
  subscribe(listener: () => void): () => void
  publish(next: EditorStatus): void
}

export function createEditorStatusStore(
  initial: EditorStatus = DEFAULT_STATUS,
): EditorStatusStore {
  let snapshot = initial
  const listeners = new Set<() => void>()

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    publish: (next) => {
      if (next.cursor === snapshot.cursor && next.mode === snapshot.mode) return
      snapshot = next
      for (const listener of listeners) listener()
    },
  }
}

export function useEditorStatus(store: EditorStatusStore): EditorStatus {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}
