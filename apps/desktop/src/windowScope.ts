/**
 * Identity of the webview this app instance runs in. The label is assigned
 * by Rust (`main` from tauri.conf.json, `editor-N` from
 * src-tauri/src/windows.rs). Outside Tauri (tests, browser builds) every
 * instance behaves as the main window.
 */
export function currentWindowLabel(): string {
  const internals = (window as { __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: unknown } } } })
    .__TAURI_INTERNALS__
  const label = internals?.metadata?.currentWindow?.label
  return typeof label === "string" && label ? label : "main"
}

export function isMainWindow(): boolean {
  return currentWindowLabel() === "main"
}
