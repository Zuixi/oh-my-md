import type { EditorView } from "@codemirror/view"
import { ConflictSaveRegion } from "./ConflictSaveRegion"
import { FindBarHost } from "./FindBarHost"
import type { DocumentStore } from "./documentStore"
import type { EditorRegistry } from "./editorRegistry"
import type { LargeDocNotice } from "./editorScalePolicy"
import type { DocumentSaveState } from "./documentSaveState"
import { LargeDocBanner } from "./LargeDocBanner"
import { NormalizationBanner } from "./NormalizationBanner"
import type { TabNormalizationState } from "./normalizationState"
import { RELEASES_URL } from "./constants"
import type { DesktopServices, DocumentErrorCode } from "./desktopServices"
import type { ConflictActionId, TopBannerKind } from "./documentSaveCoordinator"
import type { UpdateState } from "./updateCoordinator"
import { UpdateBanner } from "./UpdateBanner"
import type { FindReplaceHandle } from "./useFindReplace"

/**
 * The editor canvas: conflict/normalization/update/large-doc banners, the find
 * bar, and one host element per open tab. The tab hosts are plain divs that
 * `EditorRegistry` attaches CodeMirror views to.
 */
export function AppCanvas(props: {
  readonly services: DesktopServices
  readonly store: DocumentStore
  readonly registry: EditorRegistry
  readonly find: FindReplaceHandle
  readonly isSafeMode: () => boolean
  readonly tabs: readonly import("./session").EditorSession[]
  readonly activeTabId: number
  readonly activeView: EditorView | null
  readonly bannerKind: TopBannerKind | null
  readonly activeSaveState: DocumentSaveState
  readonly saveErrorCode?: DocumentErrorCode
  readonly activeNormalization: TabNormalizationState | undefined
  readonly normalizationBusy: boolean
  readonly skippedMarkersMessage: string | null
  readonly transientStatus: string | null
  readonly largeDocNotice: LargeDocNotice | null
  readonly updateState: UpdateState
  readonly conflict: {
    readonly diffOpenTabId: number | null
    readonly diffRefreshed: boolean
    readonly conflictFocusToken: number
    readonly onConflictAction: (action: ConflictActionId) => void
    readonly onDiffClose: () => void
    readonly onDiskFingerprintChange: (fingerprint: string) => void
  }
  readonly onAcceptNormalization: () => void
  readonly onKeepOriginalNumbers: () => void
  readonly onDismissLargeDoc: () => void
  readonly onDownloadUpdate: () => void
  readonly onDismissUpdate: () => void
  readonly onRequestInstallUpdate: () => void
  readonly onInstallUpdate: () => void
  readonly onFocusBlockedTab: (tabId: number) => void
  readonly getLocalContents: () => string
}) {
  const { store } = props
  return (
    <div className="editor-canvas">
      <ConflictSaveRegion
        bannerKind={
          props.bannerKind === "conflict" || props.bannerKind === "saveFailed"
            ? props.bannerKind
            : null
        }
        activeTabId={props.activeTabId}
        activeSaveState={props.activeSaveState}
        saveErrorCode={props.saveErrorCode}
        localContents=""
        getLocalContents={props.getLocalContents}
        diffOpenTabId={props.conflict.diffOpenTabId}
        diffRefreshed={props.conflict.diffRefreshed}
        conflictFocusToken={props.conflict.conflictFocusToken}
        activeView={props.activeView}
        onConflictAction={props.conflict.onConflictAction}
        onDiffClose={props.conflict.onDiffClose}
        onDiskFingerprintChange={props.conflict.onDiskFingerprintChange}
      />
      <NormalizationBanner
        markerCount={props.activeNormalization?.notice.markerCount ?? null}
        busy={props.normalizationBusy}
        onSave={props.onAcceptNormalization}
        onKeepOriginal={props.onKeepOriginalNumbers}
      />
      {props.skippedMarkersMessage ? (
        <p className="normalization-skipped-status" role="status">{props.skippedMarkersMessage}</p>
      ) : null}
      {props.updateState.kind !== "idle" ? (
        <UpdateBanner
          state={props.updateState}
          onDownload={props.onDownloadUpdate}
          onViewRelease={() => { void props.services.openExternal?.(RELEASES_URL) }}
          onDismiss={props.onDismissUpdate}
          onRequestInstall={props.onRequestInstallUpdate}
          onInstall={props.onInstallUpdate}
          onFocusBlockedTab={props.onFocusBlockedTab}
        />
      ) : null}
      {props.largeDocNotice && props.largeDocNotice.sessionId === props.activeTabId ? (
        <LargeDocBanner
          lines={props.largeDocNotice.lines}
          safeMode={props.largeDocNotice.safeMode}
          readonly={props.largeDocNotice.readonly}
          onDismiss={props.onDismissLargeDoc}
        />
      ) : null}
      {props.transientStatus ? (
        <p className="save-transient-status" role="status">{props.transientStatus}</p>
      ) : null}
      <FindBarHost store={store} find={props.find} isSafeMode={props.isSafeMode} />
      <div className="editor-stack">
        {props.tabs.map(tab => (
          <div
            key={tab.id}
            className="editor-host"
            hidden={tab.id !== props.activeTabId}
            ref={el => props.registry.bindHost(tab.id, el)}
          />
        ))}
      </div>
    </div>
  )
}
