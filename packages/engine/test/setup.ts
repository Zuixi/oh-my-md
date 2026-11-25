// happy-dom does not implement document.compatMode (it is undefined), while a
// standards-mode browser reports "CSS1Compat". KaTeX reads it at module load
// and refuses to render without a warning otherwise, so pin the real value.
Object.defineProperty(document, "compatMode", {
  value: "CSS1Compat",
  configurable: true,
})

// Per the W3C Selection API spec, `selectionchange` is queued as a task
// rather than fired synchronously inside Selection.collapse()/addRange().
// happy-dom dispatches it synchronously, which re-enters CodeMirror 6's
// DOMObserver.onSelectionChange -> EditorView.update([]) before updateSelection
// calls observer.setSelectionRange(). Deferring via setTimeout(0) matches
// browser task ordering without starving the event loop.
const origDispatchEvent = document.dispatchEvent.bind(document)
let selectionChangeTimer: ReturnType<typeof setTimeout> | null = null
document.dispatchEvent = (event: Event): boolean => {
  if (event.type === "selectionchange") {
    if (selectionChangeTimer === null) {
      selectionChangeTimer = setTimeout(() => {
        selectionChangeTimer = null
        origDispatchEvent(event)
      }, 0)
    }
    return true
  }
  return origDispatchEvent(event)
}
