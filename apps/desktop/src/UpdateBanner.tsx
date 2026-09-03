import { useT } from "./i18n"

export interface UpdateBannerProps {
  readonly onDownload: () => void
  readonly onDismiss: () => void
}

/** Non-modal notice linking to the latest downloadable release. */
export function UpdateBanner({ onDownload, onDismiss }: UpdateBannerProps) {
  const t = useT()
  return (
    <div className="update-banner">
      <p className="update-banner-message" role="status">{t("update.unavailable")}</p>
      <div className="update-banner-actions">
        <button type="button" className="update-banner-view" onClick={onDownload}>
          {t("update.download")}
        </button>
        <button type="button" className="update-banner-dismiss" onClick={onDismiss}>
          {t("update.dismiss")}
        </button>
      </div>
    </div>
  )
}
