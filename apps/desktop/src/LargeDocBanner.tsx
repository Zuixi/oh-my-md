import { useT } from "./i18n"

export interface LargeDocBannerProps {
  readonly lines: number
  readonly safeMode: boolean
  readonly onDismiss: () => void
}

/** Spec 05：大文档一次性非模态提示。安全模式版本必须说明关闭了什么。 */
export function LargeDocBanner({ lines, safeMode, onDismiss }: LargeDocBannerProps) {
  const t = useT()
  return (
    <div className="update-banner">
      <p className="update-banner-message" role="status">
        {t(safeMode ? "largeDoc.safeMode" : "largeDoc.notice", { lines })}
      </p>
      <div className="update-banner-actions">
        <button type="button" className="update-banner-dismiss" onClick={onDismiss}>
          {t("largeDoc.dismiss")}
        </button>
      </div>
    </div>
  )
}
