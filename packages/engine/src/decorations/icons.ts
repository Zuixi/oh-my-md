// 引擎内联 SVG 图标：path 数据常量化，零运行时依赖、无文件/网络加载，
// 框架无关（不 import lucide-react）。尺寸用 1em —— 跟随宿主 CSS 的
// font-size，替换原文本字形（✎/⚠/+row）时无需改任何尺寸规则。
// 来源与许可：Lucide v1.38.0（ISC）+ Tabler Icons v3.x（MIT），
// 完整声明见仓库根 THIRD_PARTY_NOTICES.md。升级时按常量注释里的图标名
// 回官方包重取 path 数据。

export type IconName =
  | "code"
  | "pencil"
  | "copy"
  | "check"
  | "triangle-alert"
  | "row-insert-bottom"
  | "column-insert-right"
  | "row-remove"
  | "column-remove"

/** lucide-static v1.38.0（ISC）: code, pencil, copy, check, triangle-alert */
const LUCIDE: Partial<Record<IconName, string>> = {
  "code": '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>',
  "pencil":
    '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>'
    + '<path d="m15 5 4 4"/>',
  "copy":
    '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>'
    + '<path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  "check": '<path d="M20 6 9 17l-5-5"/>',
  "triangle-alert":
    '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/>'
    + '<path d="M12 9v4"/><path d="M12 17h.01"/>',
}

/** Tabler Icons outline（MIT）: row/column insert/remove —— Lucide 无此组图标 */
const TABLER: Partial<Record<IconName, string>> = {
  "row-insert-bottom":
    '<path stroke="none" d="M0 0h24v24H0z" fill="none"/>'
    + '<path d="M20 6v4a1 1 0 0 1 -1 1h-14a1 1 0 0 1 -1 -1v-4a1 1 0 0 1 1 -1h14a1 1 0 0 1 1 1"/>'
    + '<path d="M12 15l0 4"/><path d="M14 17l-4 0"/>',
  "column-insert-right":
    '<path stroke="none" d="M0 0h24v24H0z" fill="none"/>'
    + '<path d="M6 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1v-14a1 1 0 0 1 1 -1"/>'
    + '<path d="M15 12l4 0"/><path d="M17 10l0 4"/>',
  "row-remove":
    '<path stroke="none" d="M0 0h24v24H0z" fill="none"/>'
    + '<path d="M20 6v4a1 1 0 0 1 -1 1h-14a1 1 0 0 1 -1 -1v-4a1 1 0 0 1 1 -1h14a1 1 0 0 1 1 1"/>'
    + '<path d="M10 16l4 4"/><path d="M10 20l4 -4"/>',
  "column-remove":
    '<path stroke="none" d="M0 0h24v24H0z" fill="none"/>'
    + '<path d="M6 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1v-14a1 1 0 0 1 1 -1"/>'
    + '<path d="M16 10l4 4"/><path d="M16 14l4 -4"/>',
}

const ICONS = { ...LUCIDE, ...TABLER } as Record<IconName, string>

export const ICON_NAMES = Object.keys(ICONS) as IconName[]

/** 构建内联 SVG 元素（每次新建，调用方可各自挂载）。 */
export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  svg.classList.add("omd-icon")
  svg.setAttribute("viewBox", "0 0 24 24")
  svg.setAttribute("width", "1em")
  svg.setAttribute("height", "1em")
  svg.setAttribute("fill", "none")
  svg.setAttribute("stroke", "currentColor")
  svg.setAttribute("stroke-width", "2")
  svg.setAttribute("stroke-linecap", "round")
  svg.setAttribute("stroke-linejoin", "round")
  svg.setAttribute("aria-hidden", "true")
  svg.innerHTML = ICONS[name]
  return svg
}
