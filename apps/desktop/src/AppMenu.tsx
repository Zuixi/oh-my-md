import { useEffect, useRef, useState } from "react"
import { Check } from "lucide-react"
import { MACOS_ONLY_COMMANDS, MENU_TO_COMMAND } from "./commands"
import { useT } from "./i18n"
import { APP_MENU_TREE, type MenuEntry, type MenuSection } from "./menuTree"
import { isMacOS } from "./platform"
import { shortcutFor } from "./shortcuts"

export interface AppMenuViewState {
  readonly source: boolean
  readonly sidebar: boolean
  readonly outline: boolean
  readonly typewriter: boolean
  readonly focus: boolean
}

const MENU_ITEM_SELECTOR = 'button[role="menuitem"], button[role="menuitemcheckbox"]'

/**
 * In-app horizontal menubar for Windows/Linux (VS Code/Typora form; spec D2
 * revision): macOS keeps the native global menubar, so this renders nothing
 * there. Each top-level menu opens its own dropdown; while one is open,
 * hovering another top-level button switches menus. Command ids are forwarded
 * to `onCommand`, which App wires to `runMenuCommand` exactly like native
 * menu events.
 */
export function AppMenu(props: {
  getRecents: () => string[]
  onCommand: (id: string) => void
  viewState: AppMenuViewState
}) {
  const t = useT()
  const [openIndex, setOpenIndex] = useState<number | null>(null)
  const [recentsOpen, setRecentsOpen] = useState(false)
  const [recents, setRecents] = useState<string[]>([])
  const rootRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  // Set when a menu was opened (or switched) via keyboard so the effect below
  // can move focus into the freshly rendered panel.
  const focusFirstItemRef = useRef(false)

  useEffect(() => {
    if (openIndex === null) return
    setRecents(props.getRecents())
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close()
    }
    window.addEventListener("pointerdown", onPointerDown)
    window.addEventListener("keydown", onKeyDown)
    return () => {
      window.removeEventListener("pointerdown", onPointerDown)
      window.removeEventListener("keydown", onKeyDown)
    }
    // props.getRecents 在调用时读取 App 的 ref,闭包不陈旧
  }, [openIndex])

  useEffect(() => {
    if (!focusFirstItemRef.current) return
    focusFirstItemRef.current = false
    const items = panelRef.current?.querySelectorAll<HTMLButtonElement>(MENU_ITEM_SELECTOR)
    items?.[0]?.focus()
  }, [openIndex])

  if (isMacOS()) return null

  function close() {
    setOpenIndex(null)
    setRecentsOpen(false)
  }

  const labelFor = (id: string): string => {
    if (id === "recents") return t("menu.recents")
    if (id.startsWith("recent:")) {
      return id.slice("recent:".length).replace(/\\/g, "/").split("/").pop() ?? id
    }
    return t(`cmd.label.${MENU_TO_COMMAND[id] ?? id}`)
  }

  const visible = (id: string): boolean =>
    !(MACOS_ONLY_COMMANDS.has(MENU_TO_COMMAND[id] ?? id) && !isMacOS())

  const visibleEntries = (section: MenuSection): readonly MenuEntry[] =>
    section.entries.filter(
      entry => !(entry.macOSOnly === true && !isMacOS()) && visible(entry.id),
    )

  const run = (id: string): void => {
    props.onCommand(id)
    close()
  }

  const topButton = (index: number): HTMLButtonElement | null =>
    rootRef.current?.querySelectorAll<HTMLButtonElement>(".app-menubar-item")[index] ?? null

  // 面板内方向键导航:在当前菜单的条目间 roving,两端回绕。左右方向键切换
  // 到相邻顶级菜单并继续键盘导航;Escape 关闭并把焦点还给顶级按钮。
  const handlePanelKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const panel = panelRef.current
      if (!panel) return
      const items = Array.from(
        panel.querySelectorAll<HTMLButtonElement>(MENU_ITEM_SELECTOR),
      )
      if (items.length === 0) return
      const currentIndex = items.findIndex(item => item === document.activeElement)
      const nextIndex = currentIndex < 0
        ? (event.key === "ArrowDown" ? 0 : items.length - 1)
        : (currentIndex + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length
      event.preventDefault()
      items[nextIndex].focus()
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault()
      switchMenu(
        openIndex === null ? 0 : (openIndex + (event.key === "ArrowRight" ? 1 : -1)
          + APP_MENU_TREE.length) % APP_MENU_TREE.length,
      )
    } else if (event.key === "Escape") {
      event.preventDefault()
      const index = openIndex
      close()
      if (index !== null) topButton(index)?.focus()
    } else if (event.key === "Tab") {
      close()
    }
  }

  const switchMenu = (index: number): void => {
    setRecentsOpen(false)
    focusFirstItemRef.current = true
    setOpenIndex(index)
  }

  // 顶级按钮:ArrowDown/Enter 打开并聚焦首项;未打开时左右方向键在顶级间移动
  // 焦点,已打开时直接切换菜单。
  const handleTopKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    index: number,
  ): void => {
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault()
      focusFirstItemRef.current = true
      setOpenIndex(current => (current === index ? current : index))
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault()
      const next = (index + (event.key === "ArrowRight" ? 1 : -1) + APP_MENU_TREE.length)
        % APP_MENU_TREE.length
      if (openIndex !== null) switchMenu(next)
      else topButton(next)?.focus()
    }
  }

  const renderEntry = (entry: MenuEntry) => {
    if (entry.id === "recents") {
      return (
        <div className="app-menu-entry" key={entry.id}>
          <button
            type="button"
            role="menuitem"
            className="app-menu-item"
            aria-expanded={recentsOpen}
            onClick={() => setRecentsOpen(current => !current)}
          >
            <span className="app-menu-check" aria-hidden="true" />
            <span className="app-menu-label">{t("menu.recents")}</span>
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
          {entry.separatorAfter ? (
            <div className="app-menu-separator" aria-hidden="true" />
          ) : null}
        </div>
      )
    }
    const commandId = MENU_TO_COMMAND[entry.id] ?? entry.id
    const checkState = entry.checkKey !== undefined ? props.viewState[entry.checkKey] : undefined
    return (
      <div className="app-menu-entry" key={entry.id}>
        <button
          type="button"
          role={checkState === undefined ? "menuitem" : "menuitemcheckbox"}
          aria-checked={checkState === undefined ? undefined : checkState}
          className="app-menu-item"
          onClick={() => run(entry.id)}
        >
          <span className="app-menu-check" aria-hidden="true">
            {checkState === true ? <Check size={13} /> : null}
          </span>
          <span className="app-menu-label">{labelFor(entry.id)}</span>
          {shortcutFor(commandId) ? (
            <span className="app-menu-hint" aria-hidden="true">
              {shortcutFor(commandId)}
            </span>
          ) : null}
        </button>
        {entry.separatorAfter ? (
          <div className="app-menu-separator" aria-hidden="true" />
        ) : null}
      </div>
    )
  }

  return (
    <div className="app-menubar" role="menubar" aria-label={t("menu.aria.menubar")} ref={rootRef}>
      {APP_MENU_TREE.map((section, index) => (
        <div className="app-menubar-menu" key={section.labelKey}>
          <button
            type="button"
            className={`app-menubar-item${openIndex === index ? " is-open" : ""}`}
            aria-haspopup="menu"
            aria-expanded={openIndex === index}
            onClick={() => {
              if (openIndex === index) close()
              else { setRecentsOpen(false); setOpenIndex(index) }
            }}
            onPointerEnter={() => {
              if (openIndex !== null && openIndex !== index) {
                setRecentsOpen(false)
                setOpenIndex(index)
              }
            }}
            onKeyDown={event => handleTopKeyDown(event, index)}
          >
            {t(section.labelKey)}
          </button>
          {openIndex === index ? (
            <div
              className="app-menu-panel"
              role="menu"
              aria-label={t(section.labelKey)}
              ref={panelRef}
              onKeyDown={handlePanelKeyDown}
            >
              {visibleEntries(section).map(renderEntry)}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  )
}
