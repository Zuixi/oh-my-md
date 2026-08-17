import { Compartment, StateEffect, StateField, type EditorState, type TransactionSpec } from "@codemirror/state"
import { keymap, type Command } from "@codemirror/view"
import { livePreviewField } from "../decorations/build"
import { orderedRenumber } from "../lists/ordered"

export function livePreviewExt() {
  // decorations via StateField；block widgets 只能走 field。
  // 有序列表编号写回源码走 ViewPlugin，不产出 block decoration。
  return [livePreviewField, orderedRenumber]
}

export const livePreviewCompartment = new Compartment()

export const isLivePreview = StateField.define<boolean>({
  create: () => true,
  update: (v, tr) => tr.effects.reduce((v, e) => (e.is(toggleLivePreview) ? e.value : v), v),
})

export const toggleLivePreview = StateEffect.define<boolean>()

// Pure: compute the transaction to flip the mode. No EditorView needed → testable headless.
// NOTE: packet used isLivePreview.get(state), but @codemirror/state 6.7.1 exposes the value
// via state.field(isLivePreview). Same intent, correct API.
export function applyToggle(state: EditorState): TransactionSpec {
  const on = !state.field(isLivePreview)
  return {
    effects: [
      toggleLivePreview.of(on),
      livePreviewCompartment.reconfigure(on ? livePreviewExt() : []),
    ],
  }
}

export interface ToggleKeyBinding {
  id: string
  key: string
  display: string
  run: Command
}

export const toggleKeyBindings: readonly ToggleKeyBinding[] = [
  { id: "source", key: "Mod-e", display: "⌘E", run: v => {
    v.dispatch(applyToggle(v.state))
    return true
  } },
]

export const toggleKeymap = keymap.of(toggleKeyBindings.map(({ key, run }) => ({ key, run })))

export const toggleShortcutLabels: Readonly<Record<string, string>> = Object.fromEntries(
  toggleKeyBindings.map(binding => [binding.id, binding.display]),
)