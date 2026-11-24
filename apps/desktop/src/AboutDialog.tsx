import { useEffect, useRef, useState } from "react"
import appIcon from "./assets/app-icon.png"
import { PROJECT_URL, REPO_SLUG } from "./constants"
import { currentPlatform } from "./platform"
import { useT } from "./i18n"
import { Dialog } from "./Dialog"
import type { DesktopServices } from "./desktopServices"

/**
 * About dialog for the in-app Help menu (macOS uses the native app menu, which
 * receives the same icon/version/build metadata from Rust). Version and build
 * date come from Tauri commands so the dialog cannot drift from the binary.
 *
 * Focus trap, fixed positioning and Escape belong to `Dialog`; this component
 * only renders the content.
 */
export function AboutDialog(props: {
  isOpen: boolean
  services: DesktopServices
  onClose: () => void
}) {
  const t = useT()
  const [version, setVersion] = useState<string | null>(null)
  const [buildDate, setBuildDate] = useState<string | null>(null)
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (!props.isOpen) return
    setVersion(null)
    setBuildDate(null)
    props.services.appVersion?.().then(
      value => setVersion(value),
      () => setVersion(null),
    )
    props.services.appBuildDate?.().then(
      value => setBuildDate(value),
      () => setBuildDate(null),
    )
  }, [props.isOpen, props.services])

  return (
    <Dialog
      isOpen={props.isOpen}
      onClose={props.onClose}
      ariaLabelledBy="about-dialog-title"
      className="about-dialog"
      initialFocusRef={closeButtonRef}
    >
      <div className="about-body">
        <img className="about-icon" src={appIcon} alt="" width={88} height={88} />
        <h2 className="about-name" id="about-dialog-title">{t("about.title")}</h2>
        <p className="about-version">
          {version === null ? t("about.version", { version: "…" }) : t("about.version", { version })}
        </p>
        {buildDate === null ? null : (
          <p className="about-build">{t("about.buildDate", { date: buildDate })}</p>
        )}
        <p className="about-platform">{t(`about.platform.${currentPlatform()}`)}</p>
        <button
          type="button"
          className="about-link"
          onClick={() => { void props.services.openExternal?.(PROJECT_URL) }}
        >
          github.com/{REPO_SLUG}
        </button>
      </div>
      <div className="about-actions">
        <button type="button" className="about-close-btn" onClick={props.onClose} ref={closeButtonRef}>
          {t("about.close")}
        </button>
      </div>
    </Dialog>
  )
}
