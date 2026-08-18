import { useT } from "./i18n"
import type { SnapshotEntry } from "./desktopServices"

/**
 * Version-history list for the active saved file. Restoring opens the
 * snapshot in a new untitled tab — the original file is never touched.
 */
export function VersionHistoryModal(props: {
  path: string | null
  entries: readonly SnapshotEntry[]
  loading: boolean
  onRestore: (entry: SnapshotEntry) => void
  onClear: () => void
  onClose: () => void
}) {
  const t = useT()
  return (
    <div className="palette-backdrop" onClick={props.onClose}>
      <div className="palette omd-history" onClick={event => event.stopPropagation()}>
        <h2 className="omd-history-title">{t("history.title")}</h2>
        {props.path ? (
          <p className="omd-history-path">{props.path}</p>
        ) : (
          <p className="omd-history-path">{t("history.noFile")}</p>
        )}
        <ul>
          {props.entries.map(entry => (
            <li key={entry.fileName}>
              <button type="button" onClick={() => props.onRestore(entry)}>
                <span>{new Date(entry.mtimeMs).toLocaleString()}</span>
                <kbd>{Math.max(1, Math.round(entry.sizeBytes / 1024))} KB</kbd>
              </button>
            </li>
          ))}
        </ul>
        {props.loading ? <p className="omd-history-note" role="status">{t("history.loading")}</p> : null}
        {!props.loading && props.path && props.entries.length === 0 ? (
          <p className="omd-history-note">{t("history.empty")}</p>
        ) : null}
        <div className="omd-history-actions">
          {props.path && props.entries.length > 0 ? (
            <button type="button" onClick={props.onClear}>{t("history.clear")}</button>
          ) : null}
          <button type="button" onClick={props.onClose}>{t("button.close")}</button>
        </div>
      </div>
    </div>
  )
}
