import { useEffect, useRef } from "react"
import type { OutlineItem } from "@omd/engine"
import { outlineCurrentIndex } from "@omd/engine"
import { useT } from "./i18n"
import { useEditorStatus, type EditorStatusStore } from "./editorStatusStore"

export function OutlinePanel(props: {
  items: OutlineItem[]
  statusStore: EditorStatusStore
  onJump: (from: number) => void
}) {
  const t = useT()
  const revealRef = useRef<HTMLDivElement | null>(null)
  useCurrentReveal(props.items, props.statusStore, revealRef)
  return (
    <aside className="outline">
      <div className="sidebar-title">{t("outline.title")}</div>
      <div ref={revealRef}>
        <OutlineList items={props.items} statusStore={props.statusStore} onJump={props.onJump} />
      </div>
    </aside>
  )
}

/**
 * Scrolls the freshly-changed current item into view, panel only (the hover
 * peek is transient and must never scroll). Guarded by the current *index*:
 * cursor moves inside one section trigger no scroll, and outline refreshes
 * that rebuild item objects do not re-scroll an unchanged section.
 * `block: "nearest"` keeps an already-visible item — and the user's manual
 * panel scroll — untouched; same pattern as FileTree's active-row reveal.
 */
function useCurrentReveal(
  items: OutlineItem[],
  store: EditorStatusStore,
  revealRef: React.RefObject<HTMLDivElement | null>,
) {
  const { head } = useEditorStatus(store)
  const current = outlineCurrentIndex(items, head)
  const lastRevealedRef = useRef(-1)
  useEffect(() => {
    if (current < 0 || current === lastRevealedRef.current) return
    lastRevealedRef.current = current
    const buttons = revealRef.current?.querySelectorAll<HTMLButtonElement>(".outline-item")
    buttons?.[current]?.scrollIntoView({ block: "nearest" })
  }, [current, revealRef])
}

/**
 * Heading list shared by the outline panel and the collapsed hover peek, so
 * both speak the same row-state language. "Current" follows the caret's
 * section (outlineCurrentIndex, deepest enclosing heading) — click-to-jump
 * needs no separate selection state because dispatching the selection moves
 * the caret, which moves current along. v1 boundary: pure reading scrolls do
 * not update current (documented in docs/manual-qa.md).
 */
export function OutlineList(props: {
  items: OutlineItem[]
  statusStore: EditorStatusStore
  onJump: (from: number) => void
}) {
  const { head } = useEditorStatus(props.statusStore)
  const current = outlineCurrentIndex(props.items, head)
  return (
    <>
      {props.items.map((item, i) => (
        <button
          key={`${item.from}-${item.text}`}
          type="button"
          className={`outline-item level-${item.level}${i === current ? " is-current" : ""}`}
          aria-current={i === current ? "location" : undefined}
          onClick={() => props.onJump(item.from)}
        >
          {item.text}
        </button>
      ))}
    </>
  )
}
