import { useT } from "./i18n"
import type { UpdateFailureKind, UpdateState } from "./updateCoordinator"
import type { UpdateBlockReason } from "./updateRestartReadiness"

/**
 * Non-modal state banner for the automatic-update flow (spec §11). Renders a
 * projection of `UpdateState`; the coordinator owns the state machine and the
 * raw Tauri handle, this component only maps state to plain text and actions.
 *
 * Release notes are remote plain text and are deliberately rendered as text
 * (React-evaluated), never through `dangerouslySetInnerHTML`.
 */
export interface UpdateBannerProps {
  readonly state: UpdateState
  /** `available` -> start the explicit download (or, for check-only packages, open the Release page). */
  readonly onDownload: () => void
  /** Open the official immutable GitHub Release page. */
  readonly onViewRelease: () => void
  /** Hide the banner. Never cancels an active download; the terminal state may reappear. */
  readonly onDismiss: () => void
  /** `downloaded`/`blocked` -> flush, re-check readiness, then enter the final confirmation. */
  readonly onRequestInstall: () => void
  /** `readyToInstall` final confirmation -> actually invoke the installer. */
  readonly onInstall: () => void
  /** `blocked` -> activate the first problem document. */
  readonly onFocusBlockedTab: (tabId: number) => void
}

const BLOCK_REASON_LABEL: Record<UpdateBlockReason, string> = {
  dirtyDocument: "update.block.dirtyDocument",
  saveConflict: "update.block.saveConflict",
  saveFailed: "update.block.saveFailed",
  pendingNormalization: "update.block.pendingNormalization",
  openOperation: "update.block.openOperation",
  activeSave: "update.block.activeSave",
}

/** Failures where the official Release page is the safe recovery path (spec §14). */
const RELEASE_LINK_FAILURES: ReadonlySet<UpdateFailureKind> = new Set(["signature", "install"])

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${Math.round(bytes)} B`
}

export function UpdateBanner({
  state,
  onDownload,
  onViewRelease,
  onDismiss,
  onRequestInstall,
  onInstall,
  onFocusBlockedTab,
}: UpdateBannerProps) {
  const t = useT()
  switch (state.kind) {
    case "idle":
      return null
    case "checking":
      return (
        <div className="update-banner">
          <p className="update-banner-message" role="status">{t("update.checking")}</p>
        </div>
      )
    case "available":
      return (
        <div className="update-banner">
          <p className="update-banner-message" role="status">
            {t("update.available", { version: state.update.version })}
          </p>
          {state.update.notes ? (
            <p className="update-banner-notes">{state.update.notes}</p>
          ) : null}
          <div className="update-banner-actions">
            <button type="button" className="update-banner-view" onClick={onDownload}>
              {t(state.installSupported ? "update.download" : "update.openRelease")}
            </button>
            {state.installSupported ? (
              <button type="button" className="update-banner-view" onClick={onViewRelease}>
                {t("update.viewRelease")}
              </button>
            ) : null}
            <button type="button" className="update-banner-dismiss" onClick={onDismiss}>
              {t("update.later")}
            </button>
          </div>
        </div>
      )
    case "downloading":
      return (
        <div className="update-banner">
          <p className="update-banner-message" role="status">
            {t("update.downloading", { version: state.update.version })}
          </p>
          {state.total !== undefined ? (
            <p className="update-banner-progress">
              {t("update.downloadProgress", {
                downloaded: formatBytes(state.downloaded),
                total: formatBytes(state.total),
                percent: state.total > 0
                  ? Math.round((state.downloaded / state.total) * 100)
                  : 0,
              })}
            </p>
          ) : null}
          <div className="update-banner-actions">
            <button type="button" className="update-banner-dismiss" onClick={onDismiss}>
              {t("update.hide")}
            </button>
          </div>
        </div>
      )
    case "downloaded":
      return (
        <div className="update-banner">
          <p className="update-banner-message" role="status">
            {t("update.downloaded", { version: state.update.version })}
          </p>
          <div className="update-banner-actions">
            <button type="button" className="update-banner-view" onClick={onRequestInstall}>
              {t("update.requestInstall")}
            </button>
            <button type="button" className="update-banner-dismiss" onClick={onDismiss}>
              {t("update.later")}
            </button>
          </div>
        </div>
      )
    case "blocked": {
      const first = state.reasons[0]
      return (
        <div className="update-banner">
          <p className="update-banner-message" role="status">
            {t("update.blocked", { version: state.update.version })}
          </p>
          <ul className="update-banner-blocked-list">
            {state.reasons.map(item => (
              <li key={`${item.tabId}-${item.reason}`}>
                {t("update.blockedItem", {
                  name: item.displayName,
                  reason: t(BLOCK_REASON_LABEL[item.reason]),
                })}
              </li>
            ))}
          </ul>
          <div className="update-banner-actions">
            <button
              type="button"
              className="update-banner-view"
              onClick={() => { if (first) onFocusBlockedTab(first.tabId) }}
            >
              {t("update.focusBlocked")}
            </button>
            <button type="button" className="update-banner-dismiss" onClick={onDismiss}>
              {t("update.later")}
            </button>
          </div>
        </div>
      )
    }
    case "readyToInstall":
      return (
        <div className="update-banner">
          <p className="update-banner-message" role="status">
            {t("update.readyToInstall")}
          </p>
          <div className="update-banner-actions">
            <button type="button" className="update-banner-view" onClick={onInstall}>
              {t("update.requestInstall")}
            </button>
            <button type="button" className="update-banner-dismiss" onClick={onDismiss}>
              {t("update.later")}
            </button>
          </div>
        </div>
      )
    case "installing":
      return (
        <div className="update-banner">
          <p className="update-banner-message" role="status">
            {t("update.installing", { version: state.update.version })}
          </p>
          <div className="update-banner-actions">
            {/* The app quits/relaunches on success; on Windows install may not
                resolve at all, so hiding is tolerated but never cancels. */}
            <button type="button" className="update-banner-dismiss" onClick={onDismiss}>
              {t("update.hide")}
            </button>
          </div>
        </div>
      )
    case "failed":
      return (
        <div className="update-banner">
          <p className="update-banner-message" role="status">
            {t(`update.failure.${state.failure}`)}
          </p>
          <div className="update-banner-actions">
            {RELEASE_LINK_FAILURES.has(state.failure) ? (
              <button type="button" className="update-banner-view" onClick={onViewRelease}>
                {t("update.openRelease")}
              </button>
            ) : null}
            <button type="button" className="update-banner-dismiss" onClick={onDismiss}>
              {t("update.later")}
            </button>
          </div>
        </div>
      )
  }
}
