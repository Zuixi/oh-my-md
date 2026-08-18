import { useT } from "./i18n"

export interface UpdateBannerProps {
  readonly version: string
  readonly onView: () => void
  readonly onDismiss: () => void
}

/**
 * Non-modal notice that a newer release is available. It never blocks editing
 * and never moves focus; only the message carries `role="status"` so button
 * names are not re-announced on re-render.
 */
export function UpdateBanner({ version, onView, onDismiss }: UpdateBannerProps) {
  const t = useT()
  return (
    <div className="update-banner">
      <p className="update-banner-message" role="status">{t("update.available", { version })}</p>
      <div className="update-banner-actions">
        <button type="button" className="update-banner-view" onClick={onView}>
          {t("update.view")}
        </button>
        <button type="button" className="update-banner-dismiss" onClick={onDismiss}>
          {t("update.dismiss")}
        </button>
      </div>
    </div>
  )
}
