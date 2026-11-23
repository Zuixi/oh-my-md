/**
 * Window-level input plumbing: the keydown dispatcher, the native menu channel,
 * OS "open file" requests, and Markdown drag-and-drop.
 *
 * Everything reads through refs so the listeners register once per mount; the
 * command table itself is rebuilt every render.
 */
import { useEffect, useRef, type RefObject } from "react"
import type { DesktopServices } from "./desktopServices"
import { MARKDOWN_EXTENSIONS } from "./constants"
import { runMenuCommand } from "./commands"
import type { AppCommand } from "./commands"
import { matchesWindowShortcut, WINDOW_SHORTCUTS } from "./shortcuts"
import type { FindReplaceHandle } from "./useFindReplace"

export interface GlobalShortcutsHost {
  readonly services: DesktopServices
  readonly find: FindReplaceHandle
  readonly commandsRef: RefObject<AppCommand[]>
  readonly openRecentRef: RefObject<(path: string) => Promise<void>>
  readonly openExternalRef: RefObject<(path: string) => Promise<void>>
  readonly openingLabelRef: RefObject<string | null>
  readonly cancelOpeningRef: RefObject<() => void>
  /** Modals/panels that own Escape while they are open. */
  readonly isModalChromeOpen: () => boolean
  readonly togglePalette: () => void
}

export function useGlobalShortcuts(host: GlobalShortcutsHost): void {
  // Listeners register once; every changing value is read through `latest`.
  const latest = useRef(host)
  latest.current = host
  const { services } = host

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const current = latest.current
      const find = current.find
      if (event.defaultPrevented) return
      if (event.key === "Escape" && find.openRef.current) {
        event.preventDefault()
        find.closeRef.current()
        return
      }
      if (event.key === "Escape" && current.openingLabelRef.current && !current.isModalChromeOpen()) {
        event.preventDefault()
        current.cancelOpeningRef.current()
        return
      }
      if (event.key === "p" && event.shiftKey && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        current.togglePalette()
        return
      }
      if (!event.metaKey && !event.ctrlKey) return
      // Find/replace navigation stays editor-scoped: only active while open.
      if ((event.key === "g" || event.key === "G") && find.openRef.current) {
        event.preventDefault()
        find.goRef.current(event.shiftKey ? "prev" : "next")
        return
      }
      if (event.key === "h" || event.key === "H") {
        event.preventDefault()
        find.setOpen(true)
        find.setReplaceOpen(true)
        return
      }
      const binding = WINDOW_SHORTCUTS.find(shortcut => matchesWindowShortcut(shortcut, event))
      if (!binding) return
      const command = current.commandsRef.current.find(candidate => candidate.id === binding.id)
      if (!command) return
      event.preventDefault()
      command.run()
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [])

  useEffect(() => {
    if (!services.listenMenu) return
    return services.listenMenu(id => runMenuCommand(id, latest.current.commandsRef.current, {
      openRecent: path => { void latest.current.openRecentRef.current(path) },
    }))
  }, [services])

  useEffect(() => {
    if (!services.listenOpenFile) return
    return services.listenOpenFile(path => { void latest.current.openExternalRef.current(path) })
  }, [services])

  useEffect(() => {
    if (!services.listenDragDrop) return
    return services.listenDragDrop(paths => {
      const markdown = paths.find(path => {
        const ext = path.split(".").pop()?.toLowerCase() ?? ""
        return MARKDOWN_EXTENSIONS.includes(ext)
      })
      if (markdown) void latest.current.openExternalRef.current(markdown)
    })
  }, [services])
}
