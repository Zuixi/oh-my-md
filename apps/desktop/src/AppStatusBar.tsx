import type { DocumentScaleRegistry } from "./documentScaleRegistry"
import type { DocumentStore } from "./documentStore"
import type { EditorStatusStore } from "./editorStatusStore"
import { StatusBar, type SaveStatus } from "./StatusBar"
import { useDocumentStats } from "./useDocumentStats"

/**
 * Status bar wiring. The save/normalization flags still come from the shell
 * (they change on real state transitions); the word count subscribes to the
 * active tab's materialized text on its own, so typing does not re-render `App`.
 */
export function AppStatusBar(props: {
  readonly statusStore: EditorStatusStore
  readonly store: DocumentStore
  readonly documentScaleRegistry: DocumentScaleRegistry
  /** Lines read straight from the active view's rope (never a text split). */
  readonly getActiveLines: () => number
  readonly normalizationReviewRequired: boolean
  readonly saveStatus: SaveStatus
  readonly workspace: string | null
  readonly filePath: string | null
  readonly onOpenSettings: () => void
  readonly onRevealPath?: (path: string) => void
}) {
  const { stats, requestStats } = useDocumentStats({
    store: props.store,
    isSafeMode: () => props.documentScaleRegistry
      .evaluate(props.store.getWorkspace().activeId, props.getActiveLines())
      .safeMode,
  })
  return (
    <StatusBar
      statusStore={props.statusStore}
      stats={stats}
      normalizationReviewRequired={props.normalizationReviewRequired}
      saveStatus={props.saveStatus}
      onRequestStats={stats === null ? requestStats : undefined}
      workspace={props.workspace}
      filePath={props.filePath}
      onOpenSettings={props.onOpenSettings}
      onRevealPath={props.onRevealPath}
    />
  )
}
