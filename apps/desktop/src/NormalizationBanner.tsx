export interface NormalizationBannerProps {
  readonly markerCount: number
  readonly busy: boolean
  readonly onSave: () => void
  readonly onKeepOriginal: () => void
}

const SINGLE_MARKER = 1
const NORMALIZATION_HEADLINE = "Ordered list numbers were normalized."

function renumberedSummary(markerCount: number): string {
  return markerCount === SINGLE_MARKER
    ? "1 item was renumbered."
    : `${markerCount} items were renumbered.`
}

function bannerMessage(markerCount: number): string {
  return `${NORMALIZATION_HEADLINE} ${renumberedSummary(markerCount)}`
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
 */
export function NormalizationBanner(props: NormalizationBannerProps) {
  function save() {
    if (props.busy) return
    props.onSave()
  }

  function keepOriginal() {
    if (props.busy) return
    props.onKeepOriginal()
  }

  return (
    <div className="normalization-banner">
      <span className="normalization-banner-text" role="status">
        {bannerMessage(props.markerCount)}
      </span>
      <span className="normalization-banner-actions">
        <button
          type="button"
          className="normalization-banner-action"
          aria-disabled={props.busy}
          onClick={save}
        >
          Save normalization
        </button>
        <button
          type="button"
          className="normalization-banner-action"
          aria-disabled={props.busy}
          onClick={keepOriginal}
        >
          Keep original numbers
        </button>
      </span>
    </div>
  )
}
