import { useEffect, useRef } from "react"
import { useT } from "./i18n"
import type { ConflictActionId } from "./documentSaveCoordinator"

export interface SaveConflictBannerAction {
  readonly id: ConflictActionId
  readonly label: string
}

export interface SaveConflictBannerProps {
  readonly message: string
  readonly actions: readonly SaveConflictBannerAction[]
  readonly busy: boolean
  readonly focusToken: number
  readonly onSelect: (actionId: ConflictActionId) => void
}

/**
 * Non-modal save-conflict notice. It does not steal focus on mount; only a
 * changing focusToken moves focus to the first action (for Cmd+S while a
 * conflict is active).
 */
export function SaveConflictBanner(props: SaveConflictBannerProps) {
  const t = useT()
  const firstActionRef = useRef<HTMLButtonElement>(null)
  const previousFocusTokenRef = useRef(props.focusToken)

  useEffect(() => {
    if (props.focusToken === previousFocusTokenRef.current) return
    previousFocusTokenRef.current = props.focusToken
    firstActionRef.current?.focus()
  }, [props.focusToken])

  function select(actionId: ConflictActionId) {
    if (props.busy) return
    props.onSelect(actionId)
  }

  return (
    <div className="save-conflict-banner">
      <span
        className="save-conflict-banner-text"
        role="status"
        aria-label={t("conflict.bannerLabel")}
      >
        {props.message}
      </span>
      <span className="save-conflict-banner-actions">
        {props.actions.map((action, index) => (
          <button
            key={action.id}
            ref={index === 0 ? firstActionRef : undefined}
            type="button"
            className="save-conflict-banner-action"
            disabled={props.busy}
            onClick={() => select(action.id)}
          >
            {action.label}
          </button>
        ))}
      </span>
    </div>
  )
}