import { useT } from "./i18n"

export interface OpeningOverlayProps {
  readonly label: string
  readonly progress?: { bytesRead: number; byteLength: number } | null
  readonly onCancel: () => void
}

/**
 * Spec 05b：文件打开全程可见、可取消。大文件从读取到可编辑可能要数秒，
 * 没有反馈的等待与「假死」无法区分；取消通过作废 openRequestRef 令牌实现。
 * 流式打开（LARGE 档）附带字节进度。
 */
export function OpeningOverlay({ label, progress, onCancel }: OpeningOverlayProps) {
  const t = useT()
  const percent = progress && progress.byteLength > 0
    ? Math.min(100, Math.floor((progress.bytesRead / progress.byteLength) * 100))
    : null
  return (
    <div className="opening-overlay" role="status">
      <div className="opening-overlay-card">
        <span className="opening-overlay-spinner" aria-hidden="true" />
        <p className="opening-overlay-message">
          {t("open.loadingNamed", { label })}
          {percent !== null ? ` ${percent}%` : ""}
        </p>
        <button type="button" className="opening-overlay-cancel" onClick={onCancel}>
          {t("open.cancel")}
        </button>
      </div>
    </div>
  )
}
