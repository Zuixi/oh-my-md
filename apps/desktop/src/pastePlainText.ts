import { EditorSelection } from "@codemirror/state"
import type { EditorView } from "@codemirror/view"
import { runPasteJob, type PasteJobOptions } from "./pasteJob"

export function pastePlainText(view: EditorView, options: PasteJobOptions): Promise<void> {
  return runPasteJob(
    view,
    options,
    async () => navigator.clipboard?.readText() ?? "",
    async (text, currentTarget) => {
      if (!text) return
      const target = currentTarget()
      if (target.kind !== "active") return
      const changes = target.ranges.map(range => ({ from: range.from, to: range.to, insert: text }))
      let delta = 0
      const cursors = target.ranges.map(range => {
        const anchor = range.from + delta + text.length
        delta += text.length - (range.to - range.from)
        return EditorSelection.cursor(anchor)
      })
      view.dispatch({
        changes,
        selection: EditorSelection.create(cursors),
        userEvent: "input.paste",
        scrollIntoView: true,
      })
    },
  )
}
