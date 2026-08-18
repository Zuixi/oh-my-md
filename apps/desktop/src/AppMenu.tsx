import { useEffect, useRef, useState } from "react"
import { Menu } from "lucide-react"
import { MACOS_ONLY_COMMANDS, MENU_TO_COMMAND } from "./commands"
import { useT } from "./i18n"
import { APP_MENU_TREE } from "./menuTree"
import { isMacOS } from "./platform"
import { shortcutFor } from "./shortcuts"

/**
 * In-app menu for Windows/Linux (spec D2): macOS keeps the native global
 * menubar, so this component renders nothing there. The ☰ trigger lives in
 * the TopBar; command ids are transparently forwarded to `onCommand`, which
 * App wires to `runMenuCommand` exactly like native menu events.
 */
export function AppMenu(props: { getRecents: () => string[]; onCommand: (id: string) => void }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [recentsOpen, setRecentsOpen] = useState(false)
  const [recents, setRecents] = useState<string[]>([])
  const rootRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    setRecents(props.getRecents())
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }
    window.addEventListener("pointerdown", onPointerDown)
    window.addEventListener("keydown", onKeyDown)
    return () => {
      window.removeEventListener("pointerdown", onPointerDown)
      window.removeEventListener("keydown", onKeyDown)
    }
    // props.getRecents 在调用时读取 App 的 ref,闭包不陈旧
  }, [open])

  if (isMacOS()) return null

  const labelFor = (id: string): string => {
    if (id === "recents") return t("menu.recents")
    if (id.startsWith("recent:")) {
      return id.slice("recent:".length).replace(/\\/g, "/").split("/").pop() ?? id
    }
    return t(`cmd.label.${MENU_TO_COMMAND[id] ?? id}`)
  }

  const visible = (id: string): boolean =>
    !(MACOS_ONLY_COMMANDS.has(MENU_TO_COMMAND[id] ?? id) && !isMacOS())

  // 方向键导航 (spec D2): roving focus among the rendered menu items,
  // wrapping at both ends. ArrowDown from an unfocused panel starts at the
  // first item; ArrowUp from an unfocused panel starts at the last.
  const handlePanelKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
    const panel = panelRef.current
    if (!panel) return
    const items = Array.from(
      panel.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]'),
    )
    if (items.length === 0) return
    const currentIndex = items.findIndex(item => item === document.activeElement)
    const nextIndex = currentIndex < 0
      ? (event.key === "ArrowDown" ? 0 : items.length - 1)
      : (currentIndex + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length
    event.preventDefault()
    items[nextIndex].focus()
  }

  const run = (id: string): void => {
    props.onCommand(id)
    setOpen(false)
    setRecentsOpen(false)
  }

  return (
    <div className="app-menu" ref={rootRef}>
      <button
        type="button"
        className="app-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("menu.aria.open")}
        onClick={() => setOpen(current => !current)}
      >
        <Menu size={16} aria-hidden="true" />
      </button>
      {open ? (
        <div
          className="app-menu-panel"
          role="menu"
          aria-label={t("menu.aria.open")}
          ref={panelRef}
          onKeyDown={handlePanelKeyDown}
        >
          {APP_MENU_TREE.map(section => (
            <div className="app-menu-section" key={section.labelKey}>
              <div className="app-menu-section-title">{t(section.labelKey)}</div>
              {section.entries
                .filter(entry => !(entry.macOSOnly === true && !isMacOS()) && visible(entry.id))
                .map(entry => (
                  <div className="app-menu-entry" key={entry.id}>
                    {entry.id === "recents" ? (
                      <>
                        <button
                          type="button"
                          role="menuitem"
                          className="app-menu-item"
                          aria-expanded={recentsOpen}
                          onClick={() => setRecentsOpen(current => !current)}
                        >
                          {t("menu.recents")}
                        </button>
                        {recentsOpen
                          ? recents.map(path => (
                              <button
                                type="button"
                                role="menuitem"
                                className="app-menu-item app-menu-recent"
                                key={path}
                                onClick={() => run(`recent:${path}`)}
                              >
                                {labelFor(`recent:${path}`)}
                              </button>
                            ))
                          : null}
                      </>
                    ) : (
                      <button
                        type="button"
                        role="menuitem"
                        className="app-menu-item"
                        onClick={() => run(entry.id)}
                      >
                        <span>{labelFor(entry.id)}</span>
                        {shortcutFor(MENU_TO_COMMAND[entry.id] ?? "") ? (
                          <span className="app-menu-hint" aria-hidden="true">
                            {shortcutFor(MENU_TO_COMMAND[entry.id] ?? "")}
                          </span>
                        ) : null}
                      </button>
                    )}
                    {entry.separatorAfter ? (
                      <div className="app-menu-separator" aria-hidden="true" />
                    ) : null}
                  </div>
                ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
