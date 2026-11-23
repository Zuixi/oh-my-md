// Overlay harness: mounts the real Dialog/CommandPalette stack over a miniature
// app shell (topbar + workspace body) so Playwright can verify what only a real
// browser proves — focus trap order, focus restore, `inert` on the background,
// and the IME guard that keeps Enter from executing a command mid-composition.
import { useState } from "react"
import { createRoot } from "react-dom/client"
import { CommandPalette } from "../src/CommandPalette"
import type { AppCommand } from "../src/commands"
import { setLocale } from "../src/i18n"
import "../src/styles.css"

declare global {
  interface Window {
    __ranCommands: string[]
  }
}

setLocale("en")
window.__ranCommands = []

const COMMANDS: AppCommand[] = ["alpha", "beta", "gamma"].map(name => ({
  id: name,
  label: `${name[0]!.toUpperCase()}${name.slice(1)} command`,
  run: () => { window.__ranCommands.push(name) },
}))

function Harness() {
  const [paletteOpen, setPaletteOpen] = useState(false)
  return (
    <>
      <div className="topbar">
        <button type="button">Topbar action</button>
      </div>
      <div className="workspace-body">
        <button type="button" onClick={() => setPaletteOpen(true)}>Open palette</button>
        <button type="button">Outside action</button>
      </div>
      {paletteOpen ? (
        <CommandPalette commands={COMMANDS} onClose={() => setPaletteOpen(false)} />
      ) : null}
    </>
  )
}

createRoot(document.getElementById("host")!).render(<Harness />)
