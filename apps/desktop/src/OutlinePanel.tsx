import type { OutlineItem } from "@omd/engine"
import { useT } from "./i18n"

export function OutlinePanel(props: {
  items: OutlineItem[]
  onJump: (from: number) => void
}) {
  const t = useT()
  return (
    <aside className="outline">
      <div className="sidebar-title">{t("outline.title")}</div>
      {props.items.map(item => (
        <button
          key={`${item.from}-${item.text}`}
          type="button"
          className={`outline-item level-${item.level}`}
          onClick={() => props.onJump(item.from)}
        >
          {item.text}
        </button>
      ))}
    </aside>
  )
}