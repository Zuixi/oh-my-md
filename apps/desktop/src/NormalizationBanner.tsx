import { useT } from "./i18n"

export interface NormalizationBannerProps {
  /** `null` means no review is pending: the live region stays mounted but silent. */
  readonly markerCount: number | null
  readonly busy: boolean
  readonly onSave: () => void
  readonly onKeepOriginal: () => void
}

const SINGLE_MARKER = 1

function renumberedSummary(
  t: (key: string, params?: Record<string, string | number>) => string,
  markerCount: number,
): string {
  return markerCount === SINGLE_MARKER
    ? t("normalization.single")
    : t("normalization.multiple", { count: markerCount })
}

function bannerMessage(
  t: (key: string, params?: Record<string, string | number>) => string,
  markerCount: number | null,
): string {
  if (markerCount === null) return ""
  return `${t("normalization.headline")} ${renumberedSummary(t, markerCount)}`
}

/**
 * Non-modal review notice for a pending ordered-list normalization. It never
 * moves focus and never blocks editing; the editor keeps the caret while the
 * user decides. Both actions stay reachable by Tab in reading order.
 *
 * Only the message carries `role="status"`, so a changing markerCount does not
 * re-announce the action names. While an action runs the buttons use
 * `aria-disabled` plus a handler guard instead of the native `disabled`
 * attribute: a natively disabled button loses focus the moment it is pressed,
 * which would drop a keyboard user back to the top of the document.
 *
 * The component is mounted for the whole session so that the live region is
 * already in the accessibility tree before a notice arrives; most screen
 * readers stay silent when a region and its text are inserted together. With
 * `markerCount === null` only that empty region renders, and the host collapses
 * to nothing visible.
 */
export function NormalizationBanner(props: NormalizationBannerProps) {
  const t = useT()
  const pending = props.markerCount !== null

  function save() {
    if (props.busy) return
    props.onSave()
  }

  function keepOriginal() {
    if (props.busy) return
    props.onKeepOriginal()
  }

  return (
    <div className={pending ? "normalization-banner" : "normalization-banner is-idle"}>
      <span className="normalization-banner-text" role="status">
        {bannerMessage(t, props.markerCount)}
      </span>
      {pending ? (
        <span className="normalization-banner-actions">
          <button
            type="button"
            className="normalization-banner-action"
            aria-disabled={props.busy}
            onClick={save}
          >
            {t("button.saveNormalization")}
          </button>
          <button
            type="button"
            className="normalization-banner-action"
            aria-disabled={props.busy}
            onClick={keepOriginal}
          >
            {t("button.keepOriginal")}
          </button>
        </span>
      ) : null}
    </div>
  )
}