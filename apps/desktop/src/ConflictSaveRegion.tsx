import { useCallback, useEffect, useRef, useState } from "react"
import type { EditorView } from "@codemirror/view"
import {
  CONFLICT_ACTION_LABELS,
  conflictBannerModel,
  type ConflictActionId,
  type TopBannerKind,
} from "./documentSaveCoordinator"
import { diskSnapshotFromDivergence } from "./conflictActions"
import { unifiedDiff } from "./documentDiff"
import type { DocumentErrorCode } from "./desktopServices"
import type { DocumentSaveState } from "./documentSaveState"
import { DocumentDiffPanel } from "./DocumentDiffPanel"
import { SaveConflictBanner } from "./SaveConflictBanner"
import { useT } from "./i18n"

export const DIFF_RECOMPUTE_MS = 150

export interface ConflictSaveRegionProps {
  readonly bannerKind: TopBannerKind | null
  readonly activeTabId: number
  readonly activeSaveState: DocumentSaveState
  readonly saveErrorCode?: DocumentErrorCode
  /** Static snapshot; ignored when `getLocalContents` is provided. */
  readonly localContents: string
  /**
   * Live reader for the tab's text. The shell no longer re-renders per
   * materialized keystroke, so an open diff polls this instead.
   */
  readonly getLocalContents?: () => string
  readonly diffOpenTabId: number | null
  readonly diffRefreshed: boolean
  readonly conflictFocusToken: number
  readonly activeView: EditorView | null
  readonly onConflictAction: (action: ConflictActionId) => void
  readonly onDiffClose: () => void
  readonly onDiskFingerprintChange: (fingerprint: string) => void
}

export function ConflictSaveRegion(props: ConflictSaveRegionProps) {
  const t = useT()
  const conflictModel = conflictBannerModel(props.activeSaveState, props.saveErrorCode)
  const showBanner = (props.bannerKind === "conflict" || props.bannerKind === "saveFailed")
    && conflictModel !== null

  const readLocal = useCallback(
    () => props.getLocalContents?.() ?? props.localContents,
    [props.getLocalContents, props.localContents],
  )
  const [debouncedLocal, setDebouncedLocal] = useState(readLocal)
  const diffOpen = props.diffOpenTabId === props.activeTabId
  const disk = diskSnapshotFromDivergence(props.activeSaveState.divergence)
  const prevFingerprintRef = useRef<string | null>(null)

  useEffect(() => {
    if (!diffOpen) return
    setDebouncedLocal(readLocal())
  }, [props.diffOpenTabId, props.activeTabId, readLocal])

  useEffect(() => {
    if (!diffOpen) return
    const timer = window.setTimeout(() => setDebouncedLocal(readLocal()), DIFF_RECOMPUTE_MS)
    // Without a live reader the parent's re-renders carry new contents; with one
    // the panel polls, so the diff follows typing without a shell re-render.
    if (!props.getLocalContents) return () => window.clearTimeout(timer)
    const interval = window.setInterval(() => setDebouncedLocal(readLocal()), DIFF_RECOMPUTE_MS)
    return () => {
      window.clearTimeout(timer)
      window.clearInterval(interval)
    }
  }, [props.localContents, diffOpen, readLocal, props.getLocalContents])

  useEffect(() => {
    if (!diffOpen || !disk) {
      prevFingerprintRef.current = null
      return
    }
    const fingerprint = disk.version.fingerprint
    if (prevFingerprintRef.current !== null && prevFingerprintRef.current !== fingerprint) {
      props.onDiskFingerprintChange(fingerprint)
    }
    prevFingerprintRef.current = fingerprint
  }, [disk?.version.fingerprint, diffOpen, props.onDiskFingerprintChange])

  const diffPanel = diffOpen && disk ? (
    <DocumentDiffPanel
      hunks={unifiedDiff(debouncedLocal, disk.contents)}
      deleted={false}
      refreshed={props.diffRefreshed}
      onJump={line => {
        const view = props.activeView
        if (!view) return
        try {
          const lineInfo = view.state.doc.line(line)
          view.dispatch({ selection: { anchor: lineInfo.from } })
          view.focus()
        } catch {
          /* mock views */
        }
      }}
      onClose={props.onDiffClose}
    />
  ) : null

  if (!showBanner && !diffPanel) return null

  const bannerText = showBanner && conflictModel
    ? (props.bannerKind === "saveFailed" ? conflictModel.messageKey : t(conflictModel.messageKey))
    : ""

  return (
    <>
      {showBanner && conflictModel ? (
        <SaveConflictBanner
          message={bannerText}
          actions={conflictModel.actions.map(id => ({
            id,
            label: t(CONFLICT_ACTION_LABELS[id]),
          }))}
          busy={props.activeSaveState.lifecycle.kind === "saving"}
          focusToken={props.conflictFocusToken}
          onSelect={props.onConflictAction}
        />
      ) : null}
      {diffPanel}
    </>
  )
}