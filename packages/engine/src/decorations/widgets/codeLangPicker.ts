const MAX_VISIBLE = 200

export interface CodeLangPickerOptions {
  value: string
  languages: readonly string[]
  disabled?: boolean
  onSelect: (lang: string) => void
}

function filterLanguages(languages: readonly string[], query: string): string[] {
  const q = query.trim().toLowerCase()
  const matched = q === ""
    ? [...languages]
    : languages.filter(id => id.toLowerCase().includes(q))
  return matched.slice(0, MAX_VISIBLE)
}

function displayLabel(value: string, languages: readonly string[]): string {
  const trimmed = value.trim()
  if (trimmed === "") return languages[0] ?? "text"
  return trimmed
}

export function createCodeLangPicker(options: CodeLangPickerOptions): {
  root: HTMLElement
  destroy: () => void
} {
  const { languages, disabled = false, onSelect } = options
  let value = options.value
  let open = false
  let query = ""
  let activeIndex = 0
  let popover: HTMLDivElement | null = null
  let onOutsideMouseDown: ((event: MouseEvent) => void) | null = null

  const root = document.createElement("div")
  root.className = "omd-code-lang-picker"

  const trigger = document.createElement("button")
  trigger.type = "button"
  trigger.className = "omd-code-lang-trigger"
  trigger.title = "Language"
  trigger.setAttribute("aria-haspopup", "listbox")
  trigger.disabled = disabled

  function visibleRows(): string[] {
    const rows = filterLanguages(languages, query)
    if (!query.trim() && !rows.includes(value.trim()) && value.trim()) {
      return [value.trim(), ...rows]
    }
    return rows
  }

  function syncTrigger(): void {
    trigger.textContent = displayLabel(value, languages)
    trigger.setAttribute("aria-expanded", open ? "true" : "false")
  }

  function close(): void {
    if (!open) return
    open = false
    popover?.remove()
    popover = null
    if (onOutsideMouseDown) {
      document.removeEventListener("mousedown", onOutsideMouseDown)
      onOutsideMouseDown = null
    }
    syncTrigger()
  }

  function commit(lang: string): void {
    value = lang
    onSelect(lang)
    close()
  }

  function setActive(list: HTMLElement, index: number): void {
    activeIndex = index
    list.querySelectorAll(".omd-code-lang-row").forEach((row, i) => {
      row.classList.toggle("omd-code-lang-row-active", i === index)
    })
  }

  function renderRows(list: HTMLElement, rows: string[]): void {
    list.replaceChildren()
    rows.forEach((id, index) => {
      const row = document.createElement("button")
      row.type = "button"
      row.className = index === activeIndex
        ? "omd-code-lang-row omd-code-lang-row-active"
        : "omd-code-lang-row"
      row.setAttribute("role", "option")
      row.setAttribute("aria-selected", id === value.trim() ? "true" : "false")
      row.textContent = id
      if (id === value.trim()) {
        const mark = document.createElement("span")
        mark.className = "omd-code-lang-check"
        mark.setAttribute("aria-hidden", "true")
        mark.textContent = "✓"
        row.appendChild(mark)
      }
      row.addEventListener("mousedown", event => event.stopPropagation())
      row.addEventListener("click", event => {
        event.preventDefault()
        event.stopPropagation()
        commit(id)
      })
      row.addEventListener("mouseenter", () => setActive(list, index))
      list.appendChild(row)
    })
  }

  function openPopover(): void {
    if (open || disabled) return
    open = true
    query = ""
    activeIndex = 0
    syncTrigger()

    popover = document.createElement("div")
    popover.className = "omd-code-lang-popover"

    const search = document.createElement("input")
    search.type = "search"
    search.className = "omd-code-lang-search"
    search.placeholder = "Search"
    search.setAttribute("aria-label", "Search languages")
    search.addEventListener("mousedown", event => event.stopPropagation())
    search.addEventListener("input", () => {
      query = search.value
      activeIndex = 0
      renderRows(list, visibleRows())
    })
    search.addEventListener("keydown", event => {
      const rows = visibleRows()
      if (event.key === "Escape") {
        event.preventDefault()
        event.stopPropagation()
        close()
        return
      }
      if (event.key === "ArrowDown") {
        event.preventDefault()
        setActive(list, Math.min(activeIndex + 1, rows.length - 1))
        return
      }
      if (event.key === "ArrowUp") {
        event.preventDefault()
        setActive(list, Math.max(activeIndex - 1, 0))
        return
      }
      if (event.key === "Enter") {
        event.preventDefault()
        const row = rows[activeIndex]
        if (row) commit(row)
      }
    })
    popover.appendChild(search)

    const list = document.createElement("div")
    list.className = "omd-code-lang-list"
    list.setAttribute("role", "listbox")
    list.setAttribute("aria-label", "Languages")
    popover.appendChild(list)
    renderRows(list, visibleRows())

    root.appendChild(popover)
    search.focus()

    onOutsideMouseDown = (event: MouseEvent) => {
      if (!root.contains(event.target as Node)) close()
    }
    document.addEventListener("mousedown", onOutsideMouseDown)
  }

  trigger.addEventListener("mousedown", event => event.stopPropagation())
  trigger.addEventListener("click", event => {
    event.preventDefault()
    event.stopPropagation()
    if (open) close()
    else openPopover()
  })

  syncTrigger()
  root.appendChild(trigger)
  return {
    root,
    destroy: () => close(),
  }
}
