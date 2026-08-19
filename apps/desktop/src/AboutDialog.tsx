import { useEffect, useState } from "react"
import { currentPlatform } from "./platform"
import { useT } from "./i18n"
import type { DesktopServices } from "./desktopServices"

/**
 * Minimal About dialog for the in-app Help menu (non-macOS; macOS covers this
 * with the native app menu's PredefinedMenuItem::about). Version comes from
 * the Rust `app_version` command so the dialog cannot drift from the bundle.
 */
export function AboutDialog(props: {
  isOpen: boolean
  services: DesktopServices
  onClose: () => void
}) {
  const t = useT()
  const [version, setVersion] = useState<string | null>(null)

  useEffect(() => {
    if (!props.isOpen) return
    setVersion(null)
    props.services.appVersion?.().then(
      value => setVersion(value),
      () => setVersion(null),
    )
  }, [props.isOpen, props.services])

  useEffect(() => {
    if (!props.isOpen) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation()
        props.onClose()
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [props.isOpen, props.onClose])

  if (!props.isOpen) return null

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div
        className="settings-modal about-modal"
        role="dialog"
        aria-label={t("about.title")}
        onClick={event => event.stopPropagation()}
      >
        <div className="about-body">
          <h2 className="about-name">oh-my-md</h2>
          <p className="about-version">
            {version === null ? t("about.version", { version: "…" }) : t("about.version", { version })}
          </p>
          <p className="about-platform">{t(`about.platform.${currentPlatform()}`)}</p>
        </div>
        <div className="about-actions">
          <button type="button" className="about-close-btn" onClick={props.onClose}>
            {t("about.close")}
          </button>
        </div>
      </div>
    </div>
  )
}
