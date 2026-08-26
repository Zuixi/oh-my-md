import { StateEffect } from "@codemirror/state"

export const measureBlockWidget = StateEffect.define<{ pos: number }>()
