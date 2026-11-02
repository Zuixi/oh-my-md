import { StateField, type EditorState } from "@codemirror/state"

export const searchRevisionField: StateField<number> = StateField.define<number>({
  create: () => 0,
  update(value, transaction) {
    return transaction.docChanged ? value + 1 : value
  },
})

export function currentSearchRevision(state: EditorState): number {
  return state.field(searchRevisionField, false) ?? 0
}
