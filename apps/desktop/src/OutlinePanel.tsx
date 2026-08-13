import type { OutlineItem } from "@omd/engine"

export function OutlinePanel(props: {
  items: OutlineItem[]
  onJump: (from: number) => void
}) {
  return (
    <aside className="outline">
      <div className="sidebar-title">Outline</div>
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
