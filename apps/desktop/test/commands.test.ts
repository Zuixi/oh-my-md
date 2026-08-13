import { describe, expect, it, vi } from "vitest"
import { filterCommands, runMenuCommand, type AppCommand } from "../src/commands"

const commands: AppCommand[] = [
  { id: "open", label: "Open file", run: () => undefined },
  { id: "save", label: "Save", run: () => undefined },
  { id: "theme", label: "Toggle theme", run: () => undefined },
]

describe("command registry", () => {
  it("returns every command when the query is empty", () => {
    expect(filterCommands(commands, "  ")).toEqual(commands)
  })

  it("filters by label or id", () => {
    expect(filterCommands(commands, "open").map(item => item.id)).toEqual(["open"])
    expect(filterCommands(commands, "THEME").map(item => item.id)).toEqual(["theme"])
  })

  it("maps File menu items onto the shared command registry", () => {
    const open = vi.fn()
    const folder = vi.fn()
    const save = vi.fn()
    const tab = vi.fn()
    const html = vi.fn()
    const pdf = vi.fn()
    const registry: AppCommand[] = [
      { id: "open", label: "Open file", run: open },
      { id: "folder", label: "Open folder", run: folder },
      { id: "save", label: "Save", run: save },
      { id: "tab", label: "New tab", run: tab },
      { id: "export-html", label: "Export HTML", run: html },
      { id: "export-pdf", label: "Export PDF", run: pdf },
    ]
    runMenuCommand("open-file", registry)
    runMenuCommand("open-folder", registry)
    runMenuCommand("save", registry)
    runMenuCommand("new-tab", registry)
    runMenuCommand("export-html", registry)
    runMenuCommand("export-pdf", registry)
    runMenuCommand("unknown", registry)
    expect(open).toHaveBeenCalledOnce()
    expect(folder).toHaveBeenCalledOnce()
    expect(save).toHaveBeenCalledOnce()
    expect(tab).toHaveBeenCalledOnce()
    expect(html).toHaveBeenCalledOnce()
    expect(pdf).toHaveBeenCalledOnce()
  })
})
