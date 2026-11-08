import { useEffect, useRef } from "react"
import { ChevronRight, FileText, Folder, FolderOpen } from "lucide-react"
import { markdownBaseNameEnd } from "./entryName"
import { DEPTH_INDENT, ICON_SIZE, ROW_INSET } from "./fileTreeState"
import { useT } from "./i18n"
import { EDIT_INPUT_CLASS, type TreeEdit } from "./useTreeEditSession"

/**
 * Inline edit row shared by rename and create. Enter submits, Escape cancels,
 * and IME composition never submits or cancels. Leaving the field is handled by
 * the session (rename keeps the draft, create discards it).
 */
export function TreeEditRow(props: {
  edit: TreeEdit
  depth: number
  isDirectory: boolean
  expanded: boolean
  feedbackId: string
  onChange: (value: string) => void
  onSubmit: () => void
  onCancel: () => void
  onBlur: () => void
}) {
  const t = useT()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const composingRef = useRef(false)

  // Focus and initial selection run once per session and again when an async
  // name suggestion replaces the placeholder (selectVersion). Typing does not
  // bump selectVersion, so it never steals the caret.
  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.focus({ preventScroll: true })
    const end = props.isDirectory
      ? props.edit.draft.length
      : markdownBaseNameEnd(props.edit.draft)
    input.setSelectionRange(0, end)
  }, [props.edit.id, props.edit.selectVersion, props.isDirectory])

  const label = props.edit.kind === "rename"
    ? t("filetree.prompt.rename")
    : props.edit.kind === "create-file"
      ? t("filetree.prompt.newFile")
      : t("filetree.prompt.newFolder")

  return (
    <div
      className="filetree-item is-editing"
      style={{ paddingLeft: ROW_INSET + props.depth * DEPTH_INDENT }}
      onContextMenu={event => event.stopPropagation()}
    >
      <TreeIcons isDirectory={props.isDirectory} expanded={props.expanded} />
      <input
        ref={inputRef}
        className={EDIT_INPUT_CLASS}
        aria-label={label}
        aria-describedby={props.feedbackId}
        aria-invalid={Boolean(props.edit.error)}
        aria-busy={props.edit.submitting}
        value={props.edit.draft}
        readOnly={props.edit.submitting}
        autoComplete="off"
        spellCheck={false}
        onChange={event => props.onChange(event.currentTarget.value)}
        onBlur={props.edit.kind === "rename" ? undefined : props.onBlur}
        onCompositionStart={() => { composingRef.current = true }}
        onCompositionEnd={() => { composingRef.current = false }}
        onKeyDown={event => {
          event.stopPropagation()
          if (composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229) return
          if (event.key === "Enter") {
            event.preventDefault()
            props.onSubmit()
          } else if (event.key === "Escape") {
            event.preventDefault()
            props.onCancel()
          }
        }}
      />
    </div>
  )
}

export function TreeIcons(props: { isDirectory: boolean; expanded: boolean }) {
  return <>
    <span className="filetree-chevron" aria-hidden="true">
      {props.isDirectory
        ? <ChevronRight size={ICON_SIZE} className={props.expanded ? "is-open" : undefined} />
        : null}
    </span>
    {props.isDirectory
      ? (props.expanded ? <FolderOpen size={ICON_SIZE} /> : <Folder size={ICON_SIZE} />)
      : <FileText size={ICON_SIZE} />}
  </>
}
