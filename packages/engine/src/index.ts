import { markdownLanguageSupport } from "./parse/markdown"
import { livePreviewCompartment, livePreviewExt, isLivePreview, toggleKeymap } from "./modes/livePreview"

export function editorExtensions() {
  return [
    markdownLanguageSupport(),
    livePreviewCompartment.of(livePreviewExt()),
    isLivePreview,
    toggleKeymap,
  ]
}