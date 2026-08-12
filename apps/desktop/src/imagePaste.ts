import { invoke } from "@tauri-apps/api/core"
import { EditorView } from "@codemirror/view"

// 截图粘贴 → 写到文档旁 assets/ → 插入相对路径。文档未保存时拒绝并提示。
export function imagePasteHandler(getDocPath: () => string | null) {
  return EditorView.domEventHandlers({
    paste(event, view) {
      const items = Array.from(event.clipboardData?.items ?? [])
      const item = items.find(i => i.type.startsWith("image/"))
      if (!item) return false   // 非图片粘贴交给 CM 默认
      event.preventDefault()
      const docPath = getDocPath()
      if (!docPath) { alert("Save the file before pasting an image"); return true }
      const file = item.getAsFile()
      if (!file) return true
      void insertImage(file, docPath, view)
      return true
    },
  })
}

async function insertImage(file: File, docPath: string, view: EditorView) {
  const dir = docPath.slice(0, docPath.replace(/\\/g, "/").lastIndexOf("/") + 1)
  const name = `pasted-${Date.now()}.png`
  const base64 = await fileToBase64(file)
  await invoke("write_image", { path: `${dir}assets/${name}`, base64 })
  view.dispatch(view.state.replaceSelection(`![](assets/${name})`))
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve((r.result as string).split(",")[1])
    r.onerror = reject
    r.readAsDataURL(file)
  })
}
