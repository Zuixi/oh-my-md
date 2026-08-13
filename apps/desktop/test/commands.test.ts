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
    const saveAs = vi.fn()
    const tab = vi.fn()
    const close = vi.fn()
    const html = vi.fn()
    const pdf = vi.fn()
    const image = vi.fn()
    const clearRecents = vi.fn()
    const openRecent = vi.fn()
    const registry: AppCommand[] = [
      { id: "open", label: "Open…", run: open },
      { id: "folder", label: "Open Folder…", run: folder },
      { id: "save", label: "Save", run: save },
      { id: "save-as", label: "Save As…", run: saveAs },
      { id: "tab", label: "New", run: tab },
      { id: "close", label: "Close", run: close },
      { id: "export-html", label: "Export HTML", run: html },
      { id: "export-pdf", label: "Export PDF", run: pdf },
      { id: "export-image", label: "Export Image", run: image },
      { id: "clear-recents", label: "Clear Recents", run: clearRecents },
    ]
    runMenuCommand("new", registry)
    runMenuCommand("open-file", registry)
    runMenuCommand("open-folder", registry)
    runMenuCommand("close", registry)
    runMenuCommand("save", registry)
    runMenuCommand("save-as", registry)
    runMenuCommand("export-html", registry)
    runMenuCommand("export-pdf", registry)
    runMenuCommand("export-image", registry)
    runMenuCommand("clear-recents", registry)
    runMenuCommand("recent:/notes/doc.md", registry, { openRecent })
    runMenuCommand("unknown", registry)
    expect(tab).toHaveBeenCalledOnce()
    expect(open).toHaveBeenCalledOnce()
    expect(folder).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
    expect(save).toHaveBeenCalledOnce()
    expect(saveAs).toHaveBeenCalledOnce()
    expect(html).toHaveBeenCalledOnce()
    expect(pdf).toHaveBeenCalledOnce()
    expect(image).toHaveBeenCalledOnce()
    expect(clearRecents).toHaveBeenCalledOnce()
    expect(openRecent).toHaveBeenCalledWith("/notes/doc.md")
  })

})
