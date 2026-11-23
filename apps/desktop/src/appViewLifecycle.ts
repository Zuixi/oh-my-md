import type { EditorView } from "@codemirror/view"
import type { DocumentOpen } from "./documentOpen"
import type { DocumentMaterializer } from "./documentMaterializer"

/**
 * Tears down the editor hosts owned by one App mount. Kept outside App.tsx so
 * the shell stays within its growth-frozen line budget; behavior is unchanged.
 */
export function disposeAppViews(input: {
  readonly mountedRef: { current: boolean }
  readonly materializer: Pick<DocumentMaterializer, "destroy">
  readonly viewRef: { current: EditorView | null }
  readonly viewsRef: { current: Map<number, EditorView> }
  readonly openCoordinator: Pick<DocumentOpen, "dispose">
}): void {
  input.mountedRef.current = false
  input.materializer.destroy()
  input.viewRef.current = null
  input.viewsRef.current.forEach(view => view.destroy())
  input.viewsRef.current.clear()
  input.openCoordinator.dispose()
}
