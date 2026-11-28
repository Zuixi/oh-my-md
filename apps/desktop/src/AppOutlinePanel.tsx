import { EditorView } from "@codemirror/view"
import { ListTree } from "lucide-react"
import { useEffect } from "react"
import { useWorkspace, type DocumentStore } from "./documentStore"
import type { EditorRegistry } from "./editorRegistry"
import type { EditorStatusStore } from "./editorStatusStore"
import { useT } from "./i18n"
import { OutlineList, OutlinePanel } from "./OutlinePanel"
import { useOutlineHover, useOutlineItems, type OutlineController } from "./outlineController"
import { shortcutFor } from "./shortcuts"

/**
 * The outline sidebar plus its toggle strip and hover preview. Rendered as a
 * fragment so the surrounding workspace DOM order is unchanged.
 */
export function AppOutlinePanel(props: {
  readonly store: DocumentStore
  readonly registry: EditorRegistry
  readonly outline: OutlineController
  readonly statusStore: EditorStatusStore
  readonly outlineOpen: boolean
  readonly onToggleOutline: () => void
}) {
  const t = useT()
  const activeTabId = useWorkspace(props.store).activeId
  const outline = props.outline
  const items = useOutlineItems(outline)
  const hover = useOutlineHover(outline)

  useEffect(() => {
    outline.setPanelOpen(props.outlineOpen)
  }, [outline, props.outlineOpen])

  function jump(from: number, keepOpen: boolean): void {
    const view = props.registry.getActiveView()
    if (!view) return
    try {
      if (keepOpen) {
        // CodeMirror does not scroll on a selection change by itself.
        view.dispatch({
          selection: { anchor: from },
          effects: EditorView.scrollIntoView(from, { y: "start" }),
        })
        view.focus()
      } else {
        view.dispatch({ selection: { anchor: from } })
        view.focus()
      }
    } catch {
      /* mock views */
    }
  }

  return (
    <>
      <aside
        id="outline-panel"
        className={`sidebar-secondary${props.outlineOpen ? "" : " is-hidden"}`}
        aria-hidden={!props.outlineOpen}
        inert={!props.outlineOpen}
      >
        <OutlinePanel
          key={activeTabId}
          items={items}
          statusStore={props.statusStore}
          onJump={from => jump(from, true)}
        />
      </aside>
      <div className="outline-toggle-strip">
        <button
          type="button"
          className={`outline-toggle-btn${props.outlineOpen ? " is-active" : ""}`}
          onClick={() => {
            outline.closeHover()
            props.onToggleOutline()
          }}
          onMouseEnter={outline.openHoverPreview}
          onMouseLeave={outline.scheduleHoverClose}
          aria-expanded={props.outlineOpen}
          aria-controls="outline-panel"
          aria-label={props.outlineOpen ? t("outline.aria.toggleHide") : t("outline.aria.toggleShow")}
          title={props.outlineOpen
            ? t("outline.title.toggleHide", { shortcut: shortcutFor("outline") ?? "" })
            : t("outline.title.toggleShow", { shortcut: shortcutFor("outline") ?? "" })}
        >
          <ListTree size={16} aria-hidden="true" />
        </button>
        {!props.outlineOpen && hover ? (
          <div className="outline-hover-popover" role="dialog" aria-label={t("outline.aria.preview")}>
            <div className="outline-hover-header">
              <span className="outline-hover-title">{t("outline.preview.title")}</span>
              <span className="outline-hover-hint">{t("outline.preview.hint")}</span>
            </div>
            <div className="outline-hover-body">
              {items.length === 0 ? (
                <div className="sidebar-empty">{t("outline.empty")}</div>
              ) : (
                <OutlineList
                  items={items}
                  statusStore={props.statusStore}
                  onJump={from => {
                    jump(from, false)
                    outline.closeHover()
                  }}
                />
              )}
            </div>
          </div>
        ) : null}
      </div>
    </>
  )
}
