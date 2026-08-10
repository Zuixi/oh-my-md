import { Compartment, StateEffect, StateField, type EditorState, type TransactionSpec } from "@codemirror/state"
import { keymap } from "@codemirror/view"
import { livePreviewPlugin } from "../decorations/build"

export function livePreviewExt() {
  return [livePreviewPlugin]   // decorations only; styling comes from the desktop theme
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

export const toggleKeymap = keymap.of([
  { key: "Mod-e", run: v => { v.dispatch(applyToggle(v.state)); return true } },
])