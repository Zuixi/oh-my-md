import { parseCell, type CellNode, type CellParseOptions } from "../../parse/cell"

export type ResolveSrc = (src: string) => string

function renderCellContainer(
  parent: HTMLElement,
  tag: string,
  children: CellNode[],
  resolveSrc?: ResolveSrc,
): void {
  const el = document.createElement(tag)
  for (const child of children) renderCellNode(el, child, resolveSrc)
  parent.appendChild(el)
}

// CellNode 的 DOM 投影：Preview 与表格 widget 共用这一份，导出侧的 HTML 版见 export/html.ts。
function renderCellNode(parent: HTMLElement, node: CellNode, resolveSrc?: ResolveSrc): void {
  switch (node.type) {
    case "text": parent.appendChild(document.createTextNode(node.text)); return
    case "code": {
      const el = document.createElement("code")
      el.textContent = node.text
      parent.appendChild(el)
      return
    }
    case "math": {
      const el = document.createElement("code")
      el.className = "omd-cell-math"
      el.textContent = node.text
      parent.appendChild(el)
      return
    }
    case "em": renderCellContainer(parent, "em", node.children, resolveSrc); return
    case "strong": renderCellContainer(parent, "strong", node.children, resolveSrc); return
    case "del": renderCellContainer(parent, "del", node.children, resolveSrc); return
    case "mark": renderCellContainer(parent, "mark", node.children, resolveSrc); return
    case "underline": renderCellContainer(parent, "u", node.children, resolveSrc); return
    case "kbd": renderCellContainer(parent, "kbd", node.children, resolveSrc); return
    case "sub": renderCellContainer(parent, "sub", node.children, resolveSrc); return
    case "sup": renderCellContainer(parent, "sup", node.children, resolveSrc); return
    case "link": {
      const a = document.createElement("a")
      a.href = node.href
      // title 是可选语义：没有就不写属性，避免空 title 弹出空提示。
      if (node.title !== null) a.title = node.title
      a.target = "_blank"
      a.rel = "noopener noreferrer"
      a.className = "omd-link"
      for (const child of node.children) renderCellNode(a, child, resolveSrc)
      parent.appendChild(a)
      return
    }
    case "image": {
      const img = document.createElement("img")
      img.src = resolveSrc ? resolveSrc(node.src) : node.src
      img.alt = node.alt
      if (node.title !== null) img.title = node.title
      img.className = "omd-image"
      img.onerror = () => {
        img.replaceWith(Object.assign(document.createElement("span"), {
          className: "omd-image-broken",
          textContent: node.src,
        }))
      }
      parent.appendChild(img)
      return
    }
    case "br": parent.appendChild(document.createElement("br")); return
    case "hr": parent.appendChild(document.createElement("hr")); return
    case "ul": renderCellContainer(parent, "ul", node.children, resolveSrc); return
    case "ol": renderCellContainer(parent, "ol", node.children, resolveSrc); return
    case "li": renderCellContainer(parent, "li", node.children, resolveSrc); return
    case "blockquote": renderCellContainer(parent, "blockquote", node.children, resolveSrc); return
    case "pre": {
      const pre = document.createElement("pre")
      const code = document.createElement("code")
      code.textContent = node.text
      pre.appendChild(code)
      parent.appendChild(pre)
      return
    }
  }
}

// cell 内容按引擎自有的 markdown parser 解析后再渲染（任意语法：粗体/斜体/删除线/
// 高亮/下划线/上下标/行内代码/行内数学/链接/autolink/图片/emoji/HTML 实体/`<br>`/
// 列表/引用/代码块/分隔线），不再是手写正则。`options` 原样交给 `parseCell`
// （GFM 管道屏蔽、表格外引用定义）。
export function renderTableCellContent(
  parent: HTMLElement,
  source: string,
  resolveSrc?: ResolveSrc,
  options?: CellParseOptions,
): void {
  for (const node of parseCell(source, options)) renderCellNode(parent, node, resolveSrc)
}
