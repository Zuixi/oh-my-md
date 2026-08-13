export interface NormalizationBannerProps {
  readonly markerCount: number
  readonly busy: boolean
  readonly onSave: () => void
  readonly onKeepOriginal: () => void
}

const SINGLE_MARKER = 1

function renumberedSummary(markerCount: number): string {
  return markerCount === SINGLE_MARKER
    ? "1 item was renumbered."
    : `${markerCount} items were renumbered.`
}

/**
 * Non-modal review notice for a pending ordered-list normalization. It never
 * moves focus and never blocks editing; the editor keeps the caret while the
 * user decides. Both actions stay reachable by Tab in reading order.
 */
export function NormalizationBanner(props: NormalizationBannerProps) {
  return (
    <div className="normalization-banner" role="status" aria-busy={props.busy}>
      <span className="normalization-banner-text">
        Ordered list numbers were normalized. {renumberedSummary(props.markerCount)}
      </span>
      <span className="normalization-banner-actions">
        <button
          type="button"
          className="normalization-banner-action"
          disabled={props.busy}
          onClick={props.onSave}
        >
          Save normalization
        </button>
        <button
          type="button"
          className="normalization-banner-action"
          disabled={props.busy}
          onClick={props.onKeepOriginal}
        >
          Keep original numbers
        </button>
      </span>
    </div>
  )
}
