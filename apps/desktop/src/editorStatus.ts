/**
 * The lightweight editor chrome snapshot published to the status bar, plus its
 * single equality site.
 *
 * Both producers/consumers of the snapshot deduplicate (the `Editor.ts` status
 * reporter and `editorStatusStore.ts`), and hand-written comparisons in two
 * places drift the moment a field is added. Keep the type, the compared-field
 * list, and `sameEditorStatus` together here; `test/editorStatus.test.ts`
 * fails when a produced snapshot carries a field this module does not compare.
 * This module deliberately has no imports, so neither the CodeMirror host nor
 * the React store pulls the other in.
 */
export interface EditorStatus {
  readonly cursor: string
  readonly mode: "live" | "source"
}

/** Every field that participates in `sameEditorStatus`. */
export const EDITOR_STATUS_FIELDS: readonly (keyof EditorStatus)[] = ["cursor", "mode"]

export function sameEditorStatus(a: EditorStatus, b: EditorStatus): boolean {
  return a.cursor === b.cursor && a.mode === b.mode
}
